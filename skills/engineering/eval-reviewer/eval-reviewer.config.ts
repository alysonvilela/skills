/**
 * eval-reviewer configuration — the only file you edit.
 *
 * This copy is the default. To change anything for one repo, copy this file to
 * that repo's root as `eval-reviewer.config.ts`; the runner picks it up over
 * this one. Every field is optional — what you leave out falls back to the
 * value below.
 */

export default {
  agent: {
    /**
     * Which CLI runs each persona: "pi" | "claude-code" | "codex".
     *
     * In `local` mode this is the CLI already installed and authenticated on
     * your machine — the same one you code with. Nothing is re-authenticated.
     */
    provider: "pi",

    /**
     * Model, in whatever form the chosen CLI expects.
     *
     * pi accepts "provider/id" and resolves it against its own registry
     * (~/.pi/agent/models.json), so an OpenAI-compatible endpoint is just a
     * provider entry there and a name here:
     *
     *   "lm-studio/gemma-4-e2b-it"   → the lm-studio provider in models.json
     *   "anthropic/claude-sonnet-4-6"
     *
     * claude-code and codex take their own model ids ("claude-sonnet-4-6",
     * "gpt-5.4").
     */
    model: "lm-studio/gemma-4-e2b-it",

    /** Reasoning effort: off | minimal | low | medium | high | xhigh. */
    thinking: "medium",
  },

  execution: {
    /**
     * Where each persona runs.
     *
     * "local"  — on this machine, through the agent CLI you already use. It
     *            inherits your shell, so whatever authenticates your harness
     *            (OAuth on disk, ~/.pi/agent/models.json, an exported key)
     *            authenticates the review. Nothing to configure.
     * "docker" — in a container, one per persona. The container has none of
     *            your host auth, so it needs `docker.mounts` and/or
     *            `docker.forwardEnv` below.
     *
     * Under CI this is forced to "local": a CI runner is already a disposable
     * VM, and a container inside it only adds an image build per run.
     */
    mode: "local",

    /** Personas alive at once. Each is a full agent run. */
    concurrency: 3,

    /** Seconds without agent output before that persona is declared stuck. */
    idleTimeoutSeconds: 600,

    /** Re-asks when a persona's JSON fails validation (session is resumed). */
    retries: 2,
  },

  docker: {
    /** Built on first use from the skill's docker/Dockerfile when missing. */
    image: "sandcastle:eval-reviewer",

    /**
     * Host paths bind-mounted into each container. `~` expands on both sides.
     * A path that does not exist on the host is skipped with a warning.
     *
     * The default carries pi's provider registry in, so a sandboxed pi reaches
     * the same OpenAI-compatible endpoint your host pi does. Swap it for
     * ~/.claude or ~/.codex if you changed `agent.provider`.
     */
    mounts: [
      { hostPath: "~/.pi/agent", sandboxPath: "~/.pi/agent", readonly: true },
    ],

    /**
     * Environment variables copied from your shell into each container — names
     * only, so no key is ever written into this file. Whatever your provider
     * registry refers to (`"apiKey": "$OPENAI_API_KEY"`) belongs here.
     */
    forwardEnv: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  },

  review: {
    /**
     * Each name maps to a prompt at references/<name>.md.
     *
     * `critical: true` means the review is not trustworthy without it — if one
     * of those fails, the verdict is INCOMPLETE regardless of what the others
     * found. A clean PASS that silently skipped the security review is a lie.
     */
    personas: [
      { name: "skeptic", critical: true },
      { name: "architect", critical: true },
      { name: "security", critical: true },
      { name: "minimalist", critical: false },
      { name: "performance", critical: false },
      { name: "test-coverage", critical: false },
    ],

    /** Severity that makes the exit code non-zero: critical|high|medium|low|never. */
    failOn: "high",

    /** Where report.md, verdict.json, and the per-persona logs land. */
    outDir: ".eval-reviewer",
  },
};
