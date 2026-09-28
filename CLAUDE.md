## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Persistent memory (Obsidian vault)

Durable project memory: `C:\Users\iamva\Documents\Obsidian Vault\30-Projects\Active\rubo.md`.

Context order: graphify query → vault note → raw source. Never grep to orient.
`/resume` to load state, `/save` to write it back.

The local vault is a read-only replica. Vault edits must be pushed to the VPS
(`openclaw@100.107.141.83:/home/openclaw/.openclaw/obsidian-vault`) or the next sync
deletes them.
