import type { Configuration, ConfigurationsManager } from '../../core/configurations.js'

export class GuildsConfigurations {
  private readonly configuration: Configuration

  constructor(manager: ConfigurationsManager) {
    this.configuration = manager.create('guilds')
  }

  public getAllowSelfTransfer(): boolean {
    return this.configuration.getBoolean('allowSelfTransfer', false)
  }

  public setAllowSelfTransfer(enabled: boolean): void {
    this.configuration.setBoolean('allowSelfTransfer', enabled)
  }

  public getForceTransfer(): boolean {
    return this.configuration.getBoolean('forceTransfer', false)
  }

  public setForceTransfer(enabled: boolean): void {
    this.configuration.setBoolean('forceTransfer', enabled)
  }
}
