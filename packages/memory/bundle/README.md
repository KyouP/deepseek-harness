# @deepseek-ai/dsh-memory

The H-MEM persona memory bundle for DeepSeek Harness. Adding this bundle to a
profile mounts `@deepseek-ai/dsh-memory-core`: a local SQLite-backed long-term
memory giving the agent two self-editable M1 core blocks (persona / human), an
active-commitment tracker injected into the system prompt, a per-session
scratchpad, and the model-facing tools `memory_store`, `memory_note`,
`memory_update_core`, `memory_recall`, `memory_expand` and `memory_forget`.

All state stays on the local machine in one SQLite database.

## Install

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-memory
```

The package declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`,
so `dsh plugin add` joins it to the profile's bundle layer stack
(`dsh.profile.bundles`); its patch inserts the single `memory-core` row.

## Configuration

The patch row's `config` is passed to `@deepseek-ai/dsh-memory-core`. All
fields are optional; restating the row in a later layer (profile
`cordis.patch.yml` or a `--patch` overlay) replaces the whole config.

| Field     | Type   | Default                          | Description                                                        |
| --------- | ------ | -------------------------------- | ------------------------------------------------------------------ |
| `dbPath`  | string | `$DSH_HOME/storages/hmem.db`     | SQLite database file for all memory state.                         |
| `persona` | string | `''`                             | Seed text for the persona core block, applied only if never written. |
| `human`   | string | `''`                             | Seed text for the human core block, applied only if never written.  |

Example overlay:

```yaml
- insert:
    - id: memory-core
      name: '@deepseek-ai/dsh-memory-core'
      config:
        dbPath: /data/hmem.db
        persona: 你是用户的长期搭档，语气温和直接。
```

## License

MIT
