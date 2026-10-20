import assert from 'node:assert'

import type Application from '../../../application.js'
import { Status } from '../../../common/connectable-instance.js'
import type { MinecraftUser } from '../../../common/user.js'
import { ConditionResultType } from '../../../core/conditions/common.js'
import type { HypixelGuild, HypixelGuildMember } from '../../../core/hypixel/hypixel-guild.js'
import type MinecraftInstance from '../../../instance/minecraft/minecraft-instance.js'
import type {
  Database,
  MinecraftGuild,
  MinecraftGuildRole,
  SavedGuildStayCondition,
  SavedGuildTransferCondition
} from '../database.js'

export async function resolveGuildRank(
  application: Application,
  database: Database,
  currentTime: number,
  savedGuild: MinecraftGuild,
  guild: HypixelGuild,
  guildMember: HypixelGuildMember,
  targetUser: MinecraftUser
): Promise<{ rank: string; condition: string } | 'not-whitelisted' | 'no-rank' | 'no-condition'> {
  const defaultRank = guild.ranks.find((rank) => rank.default)?.name
  assert.ok(defaultRank !== undefined)
  const memberRank = guildMember.rank ?? defaultRank
  const currentSavedRank = savedGuild.roles.find((role) => role.name === memberRank)
  if (!currentSavedRank?.whitelisted) {
    return 'not-whitelisted'
  }

  const sortedRanks = guild.ranks.toSorted((a, b) => a.priority - b.priority)
  const whitelistedRoles: MinecraftGuildRole[] = []
  for (const sortedRank of sortedRanks) {
    if (sortedRank.default) continue // default used as a fallback in case no condition is met

    const whitelistedRole = savedGuild.roles.find((role) => role.name === sortedRank.name)
    if (whitelistedRole !== undefined) whitelistedRoles.push(whitelistedRole)
  }

  const registry = application.core.conditonsRegistry
  const roleConditions = database.getRoleConditions(savedGuild.id)
  const conditionContext = {
    application: application,
    startTime: currentTime,
    abortSignal: new AbortController().signal
  }

  if (roleConditions.length === 0) {
    return 'no-condition'
  }

  for (const whitelistedRole of whitelistedRoles.toReversed()) {
    for (const roleCondition of roleConditions) {
      if (whitelistedRole.name !== roleCondition.role) continue
      const handler = registry.get(roleCondition.typeId)
      if (handler === undefined) continue
      const conditionsResult = await handler.meetsCondition(
        conditionContext,
        { user: targetUser },
        roleCondition.options
      )
      if (conditionsResult.type === ConditionResultType.Pass) {
        const display = await handler.displayCondition(
          { ...conditionContext, discordGuild: undefined },
          roleCondition.options
        )
        return { rank: whitelistedRole.name, condition: display }
      }
    }
  }

  return 'no-rank'
}

export async function countMetConditions(
  application: Application,
  database: Database,
  currentTime: number,
  conditions: SavedGuildStayCondition[] | SavedGuildTransferCondition[],
  targetUser: MinecraftUser
): Promise<number> {
  const registry = application.core.conditonsRegistry
  const conditionContext = {
    application: application,
    startTime: currentTime,
    abortSignal: new AbortController().signal
  }
  let met = 0
  for (const condition of conditions) {
    const handler = registry.get(condition.typeId)
    if (handler === undefined) continue
    const conditionsResult = await handler.meetsCondition(conditionContext, { user: targetUser }, condition.options)
    if (conditionsResult.type === ConditionResultType.Pass) met++
  }
  return met
}

/**
 * Find the best guild the user could transfer into.
 * Candidates are transferable registered guilds (other than the current one) with transfer conditions set up,
 * ordered by their transfer priority (higher first).
 *
 * @return the guild to transfer into, or why no transfer is possible
 */
export async function resolveGuildTransfer(
  application: Application,
  database: Database,
  currentTime: number,
  currentSavedGuild: MinecraftGuild,
  targetUser: MinecraftUser
): Promise<MinecraftGuild | 'current-not-transferable' | 'no-target'> {
  if (!database.getTransferable(currentSavedGuild.id)) return 'current-not-transferable'

  const currentPriority = database.getTransferPriority(currentSavedGuild.id)
  const candidates = database
    .allGuilds()
    .filter((guild) => guild.id !== currentSavedGuild.id)
    .filter((guild) => database.getTransferPriority(guild.id) > currentPriority)
    .filter((guild) => database.getTransferable(guild.id))
    .filter((guild) => database.getTransferConditions(guild.id).length > 0)
    .toSorted((a, b) => database.getTransferPriority(b.id) - database.getTransferPriority(a.id))

  for (const candidate of candidates) {
    const conditions = database.getTransferConditions(candidate.id)
    const met = await countMetConditions(application, database, currentTime, conditions, targetUser)
    const needed = database.getTransferConditionMode(candidate.id)
    if (met >= needed) return candidate
  }

  return 'no-target'
}

/**
 * Whether the user still satisfies the stay requirements of the guild they are in.
 * Guilds without stay conditions are considered satisfied.
 */
export async function meetsGuildStayConditions(
  application: Application,
  database: Database,
  currentTime: number,
  savedGuild: MinecraftGuild,
  targetUser: MinecraftUser
): Promise<boolean> {
  const conditions = database.getStayConditions(savedGuild.id)
  if (conditions.length === 0) return true
  const met = await countMetConditions(application, database, currentTime, conditions, targetUser)
  return met >= database.getNeededStayConditions(savedGuild.id)
}

export async function findInstanceByGuild(
  application: Application,
  savedGuild: MinecraftGuild
): Promise<MinecraftInstance | undefined> {
  const instances = application.minecraftManager.getAllInstances()
  for (const instance of instances) {
    if (instance.currentStatus() !== Status.Connected) continue
    const guildListResult = await instance.guildManager.list().catch(() => undefined)
    if (guildListResult === undefined) continue

    if (guildListResult.name.toLowerCase().trim() === savedGuild.name.toLowerCase().trim()) {
      return instance
    }
  }

  return undefined
}
