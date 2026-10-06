export const CPA_PRIVACY_USER_AGENT: 'opencode'
export interface CpaPrivacyClient {
  request(input: { path: string; method?: string; query?: Record<string, string>; headers?: Record<string, string>; body?: string }): Promise<{ status: number; body: Uint8Array }>
}
export function cpaPrivacyHeaders(value: unknown, provider?: string): Record<string, unknown>
export function cpaPrivacyDefaultsPatch(config: unknown): Record<string, unknown>
export function cpaPrivacyApiKeysPatch(config: unknown): Record<string, unknown>
export function cpaPrivacyCredentialPatch(document: unknown): Record<string, unknown>
export function applyCpaPrivacyPolicy(client: CpaPrivacyClient, options?: { fileNames?: string[] }): Promise<{ changed: boolean; updatedFiles: number }>
