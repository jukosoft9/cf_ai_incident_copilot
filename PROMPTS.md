# AI use

## Development

This project was built with Claude Code, which wrote the code, tests and documentation under my direction. I set the brief and constraints, chose the app idea from its proposals, and approved the key steps. It also tested the app against the real model, as listed in the [README](README.md#test).

## Prompts in the running application

Every prompt the app sends to the LLM is in [`src/prompts.ts`](src/prompts.ts):

| Prompt | Purpose |
| --- | --- |
| `chatSystemPrompt` | Chat: asks for specific evidence, and includes the investigation's findings |
| `TRIAGE_SYSTEM`, `triagePrompt` | Severity, summary and impact, as JSON |
| `DIAGNOSIS_SYSTEM`, `diagnosisPrompt` | Ranked hypotheses and a proposed fix, as JSON |
| `POSTMORTEM_SYSTEM`, `postmortemPrompt` | A blameless postmortem in Markdown |
