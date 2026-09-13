import { createLinuxSandboxProvider } from './linux.ts'
import { createMacosSandboxProvider } from './macos.ts'
import { createWindowsSandboxProvider } from './windows.ts'
import type { LocalSandboxProvider, LocalSandboxProviderOptions } from './shared.ts'

export type { LocalDiscovery, LocalPlatform, LocalSandboxProvider, LocalSandboxProviderOptions } from './shared.ts'
export { createLinuxSandboxProvider } from './linux.ts'
export { createMacosSandboxProvider } from './macos.ts'
export { createWindowsSandboxProvider } from './windows.ts'

/** Dispatches by process.platform unless an explicit platform is supplied for deterministic tests. */
export async function createLocalSandboxProvider(options: LocalSandboxProviderOptions = {}): Promise<LocalSandboxProvider> {
  switch (options.platform ?? process.platform) {
    case 'linux': return createLinuxSandboxProvider(options)
    case 'darwin': return createMacosSandboxProvider(options)
    case 'win32': return createWindowsSandboxProvider(options)
    default: throw new Error(`local sandbox provider is unavailable on '${options.platform ?? process.platform}'`)
  }
}