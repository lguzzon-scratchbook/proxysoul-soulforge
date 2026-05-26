import { checkProviders } from "../core/llm/provider.js";
import { getAllProviders } from "../core/llm/providers/index.js";
import { getProviderApiKey, setSecret } from "../core/secrets.js";
import { BOLD, DIM, EXIT_ERROR, GREEN, PURPLE, RED, RST } from "./constants.js";

export async function listProviders(): Promise<void> {
  const statuses = await checkProviders();
  const providers = getAllProviders();
  const customIds = new Set(providers.filter((p) => p.custom).map((p) => p.id));

  // Addon-gated providers (proxy, etc.) have envVar="" and a custom
  // checkAvailability that returns false when the addon is missing. Skip
  // those rows entirely — listing "no key" for a provider that takes no key
  // is misleading. Keep them visible once the addon is installed.
  for (const s of statuses) {
    const isAddonGated = s.envVar === "";
    if (isAddonGated && !s.available) continue;
    const tag = customIds.has(s.id) ? ` ${DIM}[custom]${RST}` : "";
    const mark = s.available ? `${GREEN()}ready${RST}` : `${DIM}no key${RST}`;
    const env = s.envVar ? `  ${DIM}(${s.envVar})${RST}` : "";
    process.stdout.write(
      `${s.available ? GREEN() : DIM}${s.id.padEnd(18)}${RST} ${mark}${env}${tag}\n`,
    );
  }
}

export async function listModels(providerId?: string): Promise<void> {
  const providers = getAllProviders();
  const targets = providerId ? providers.filter((p) => p.id === providerId) : providers;

  if (targets.length === 0) {
    process.stderr.write(`${RED()}Error:${RST} Unknown provider "${providerId ?? ""}"\n`);
    process.stderr.write(`Available: ${providers.map((p) => p.id).join(", ")}\n`);
    process.exit(EXIT_ERROR);
  }

  for (const provider of targets) {
    // Addon-gated providers (envVar="") with custom checkAvailability — skip
    // when the addon isn't installed unless the user explicitly named it.
    if (provider.envVar === "" && provider.checkAvailability && !providerId) {
      const available = await provider.checkAvailability();
      if (!available) continue;
    }
    const hasKey = provider.envVar === "" || Boolean(getProviderApiKey(provider.envVar));
    if (!hasKey && !providerId) continue;

    const tag = provider.custom ? ` ${DIM}[custom]${RST}` : "";
    process.stdout.write(
      `${BOLD}${PURPLE()}${provider.name}${RST} ${DIM}(${provider.id})${RST}${tag}\n`,
    );

    let models = await provider.fetchModels().catch((err: unknown) => {
      process.stderr.write(
        `${DIM}  (model fetch failed: ${err instanceof Error ? err.message : String(err)} — showing cached models)${RST}\n`,
      );
      return null;
    });
    if (!models) models = provider.fallbackModels;

    for (const m of models) {
      const ctx = m.contextWindow
        ? `  ${DIM}${String(Math.round(m.contextWindow / 1000))}k ctx${RST}`
        : "";
      process.stdout.write(`  ${provider.id}/${m.id}${ctx}\n`);
    }
    process.stdout.write("\n");
  }
}

export function setKey(providerId: string, key: string): void {
  const provider = getAllProviders().find((p) => p.id === providerId);
  if (!provider) {
    const allIds = getAllProviders().map((p) => p.id);
    process.stderr.write(`${RED()}Error:${RST} Unknown provider "${providerId}"\n`);
    process.stderr.write(`Available: ${allIds.join(", ")}\n`);
    process.exit(EXIT_ERROR);
  }

  const secretId = provider.secretKey ?? provider.envVar;
  if (!secretId) {
    process.stderr.write(`${RED()}Error:${RST} Provider "${providerId}" does not use an API key\n`);
    process.exit(EXIT_ERROR);
  }

  const result = setSecret(secretId, key);
  if (result.success) {
    const where = result.storage === "keychain" ? "system keychain" : "~/.soulforge/secrets.json";
    process.stdout.write(`${GREEN()}Saved${RST} ${providerId} key to ${where}\n`);
  } else {
    process.stderr.write(`${RED()}Error:${RST} Failed to save key\n`);
    process.exit(EXIT_ERROR);
  }
}
