import assert from 'node:assert'

import { TTLCache } from '@isaacs/ttlcache'

import { ChannelType, Permission } from '../../../common/application-event.js'
import type { ChatCommandContext, ChatCommandRequirements } from '../../../common/commands.js'
import { ChatCommandGroup, ChatCommandHandler } from '../../../common/commands.js'
import type { MinecraftUser, MojangProfile } from '../../../common/user.js'
import { GuildInviteStatus } from '../../../instance/minecraft/guild-manager.js'
import { checkChatTriggers, KickChat } from '../../../utility/chat-triggers.js'
import Duration from '../../../utility/duration.js'
import { formatTime, sleep } from '../../../utility/shared-utility.js'
import type { Database } from '../database.js'
import type { GuildsConfigurations } from '../guilds-configurations.js'

import { findInstanceByGuild, resolveGuildTransfer } from './utlity.js'

export default class Transfer extends ChatCommandHandler {
  private static readonly Cooldown = Duration.minutes(5)
  private readonly cooldowns = new TTLCache<MojangProfile['id'], { createdAt: number }>({
    ttl: Transfer.Cooldown.toMilliseconds()
  })

  constructor(
    private readonly database: Database,
    private readonly configuration: GuildsConfigurations
  ) {
    super({
      type: ChatCommandGroup.Management,
      id: 'transfer',
      triggers: ['transfer', 'guildtransfer'],
      description: 'Transfer yourself to a higher guild that you meet the requirements for',
      example: `transfer`
    })
  }

  override requirements(): ChatCommandRequirements | string {
    return { sources: [ChannelType.Public, ChannelType.Officer] }
  }

  async handler(context: ChatCommandContext): Promise<string> {
    const hypixel = context.app.hypixel()
    if (hypixel === undefined) return 'Hypixel API is not set.'

    const currentTime = Date.now()

    if (!this.configuration.getAllowSelfTransfer()) {
      return 'Transferring between guilds is currently disabled.'
    }

    const target = await this.resolveUser(context)
    if (typeof target === 'string') return target
    const targetProfile = target.mojangProfile()

    const isOrdinaryUser = (await context.message.user.permission()) === Permission.Anyone
    if (isOrdinaryUser) {
      const cooldownResult = this.cooldowns.get(targetProfile.id)
      if (cooldownResult !== undefined && cooldownResult.createdAt + Transfer.Cooldown.toMilliseconds() > currentTime) {
        const againIn = cooldownResult.createdAt + Transfer.Cooldown.toMilliseconds() - currentTime
        return `${context.username}, you can use this command again in ${formatTime(againIn)}.`
      }
    }

    const guild = await hypixel.getGuildByPlayer(targetProfile.id, currentTime)
    if (guild === undefined) return `${targetProfile.name} is not in a guild.`
    const guildMember = guild.members.find((member) => member.uuid === targetProfile.id)
    assert.ok(guildMember !== undefined)

    const currentSavedGuild = this.database.allGuilds().find((savedGuild) => savedGuild.id === guild._id)
    if (currentSavedGuild === undefined) return `${targetProfile.name} is in an outside guild: ${guild.name}.`

    const resolved = await resolveGuildTransfer(context.app, this.database, currentTime, currentSavedGuild, target)
    if (resolved === 'current-not-transferable') {
      return `${targetProfile.name}, your current guild ${currentSavedGuild.name} does not allow transfers.`
    }
    if (resolved === 'no-target') {
      return `${targetProfile.name} does not meet the transfer requirements of any other guild.`
    }
    const targetGuild = resolved

    const currentInstance = await findInstanceByGuild(context.app, currentSavedGuild)
    if (currentInstance === undefined)
      return 'Can not process this request right now due to inability to connect to Hypixel'

    const targetInstance = await findInstanceByGuild(context.app, targetGuild)
    if (targetInstance === undefined)
      return 'Can not process this request right now due to inability to connect to Hypixel'

    // check the target guild has space before kicking, so a failed invite never leaves the user guildless
    const targetGuildList = await targetInstance.guildManager.list()
    if (targetGuildList.members.length >= Transfer.MaxGuildMembers) {
      return `Target guild ${targetGuild.name} is full. Transfer aborted, you stay in ${currentSavedGuild.name}.`
    }

    const kickCommand = `/guild kick ${targetProfile.id} Guild transfer to ${targetGuild.name}`
    const kickResult = await checkChatTriggers(
      context.app,
      KickChat,
      [currentInstance],
      kickCommand,
      targetProfile.name
    )
    if (kickResult.status !== 'success') {
      const reason = kickResult.message.length > 0 ? kickResult.message[0].content : 'Unknown error / Timeout'
      return `Failed to kick you from ${currentSavedGuild.name}: ${reason}`
    }

    if (isOrdinaryUser) {
      this.cooldowns.set(targetProfile.id, { createdAt: currentTime })
    }

    const offerSourceGuildRecovery = async (): Promise<void> => {
      await currentInstance.guildManager.invite(targetProfile.name).catch(() => undefined)
    }

    await sleep(2000)
    const inviteResult = await targetInstance.guildManager.invite(targetProfile.name).catch(() => undefined)
    if (inviteResult === undefined) {
      await offerSourceGuildRecovery()
      return `You were kicked from ${currentSavedGuild.name} but the invite to ${targetGuild.name} failed. Ask staff for help.`
    }

    switch (inviteResult) {
      case GuildInviteStatus.Joined: {
        return `${targetProfile.name} transferred from ${currentSavedGuild.name} to ${targetGuild.name}!`
      }
      case GuildInviteStatus.OnlineInvite:
      case GuildInviteStatus.OfflineInvite: {
        return `${targetProfile.name} was invited to ${targetGuild.name}. They must accept the invite within five minutes.`
      }
      case GuildInviteStatus.AlreadyJoined: {
        return `${targetProfile.name} is already in ${targetGuild.name}.`
      }
      case GuildInviteStatus.GuildFull: {
        await offerSourceGuildRecovery()
        return `Target guild ${targetGuild.name} filled up before the invite. Ask staff for help.`
      }
      case GuildInviteStatus.NoPermission: {
        await offerSourceGuildRecovery()
        return `No permission to invite you to ${targetGuild.name}. Ask staff for help.`
      }
      case GuildInviteStatus.PlayerPrivate: {
        await offerSourceGuildRecovery()
        return `Change your social settings to allow guild invite from anyone. You were kicked from ${currentSavedGuild.name}.`
      }
      default: {
        await offerSourceGuildRecovery()
        return `Invite to ${targetGuild.name} did not go through. Ask staff for help. You were kicked from ${currentSavedGuild.name}.`
      }
    }
  }

  private static readonly MaxGuildMembers = 125

  private async resolveUser(context: ChatCommandContext): Promise<MinecraftUser | string> {
    const originUser = context.message.user
    if (!originUser.isMojangUser()) {
      return 'Can not find your Mojang profile. Do `/link` before trying again'
    }

    const permission = await originUser.permission()
    if (permission === Permission.Anyone) return originUser

    const givenUsername = context.args.at(0)
    if (givenUsername === undefined) return originUser

    const profile = await context.app.mojangApi.profileByUsername(givenUsername).catch(() => undefined)
    if (profile === undefined) return 'No such username found.'
    return await context.app.core.initializeMinecraftUser(profile, { guild: undefined })
  }
}
