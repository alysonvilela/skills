# Akita — Revisor Multi-Agente com Matriz de Personalidades

**Revisor de código e planos inspirado nos princípios de Fabio Akita.**

Múltiplos revisores pegam coisas diferentes. "It works" é só 25% do esforço.
Comece pelo desejo, não pela arquitetura. Toda decisão deve ter o mínimo
necessário primeiro com observação de evolução.

## Filosofia

Este skill incorpora os princípios extraídos dos artigos do Fabio Akita
e consolidados na [wiki pessoal](../../wiki/wiki/concepts/production-readiness.md):

| Princípio | Origem |
|-----------|--------|
| Múltiplos revisores pegam coisas diferentes | Akita: Claude Code + Codex acharam buracos diferentes |
| 75% Rule: "it works" é só 25% | 50 de 201 commits, 2 de 6 dias |
| Comece pelo desejo, não pela arquitetura | IDEA.md > technical spec |
| Idempotência acima de tudo | Jobs não idempotentes são bombas-relógio |
| Null vs Zero | nil != 0, tratar como igual causa conclusões erradas |
| Todo input é hostil | Segurança em múltiplas camadas |

## Arquitetura

```
Usuário → PR Link ou Arquivo de Plano
                    │
                    ▼
      ┌─────────────────────────────┐
      │      ORQUESTRADOR           │
      │  (você - prepara input,     │
      │   dispara, coleta, consolida)│
      └──────┬──────┬──────┬────────┘
             │      │      │
    ┌────────┘      │      └────────┐
    ▼               ▼               ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Cético   │  │Arquiteto │  │ Minimalista  │
│ · Bugs   │  │· Acoplam.│  │ · Over-eng.  │
│ · Edge   │  │· Bound.  │  │ · Simplificar│
│ · Errors │  │· Escala  │  │ · Deletar    │
└──────────┘  └──────────┘  └──────────────┘
    ▼               ▼               ▼
┌──────────┐  ┌──────────┐  ┌──────────────┐
│ Segurança│  │ Produção │  │              │
│ · Dados  │  │ · Tests  │  │              │
│ · Inject │  │ · Deploy │  │              │
│ · Secrets│  │ · Observ │  │              │
└──────────┘  └──────────┘  └──────────────┘
    │               │               │
    └───────────────┼───────────────┘
                    ▼
      ┌─────────────────────────────┐
      │    CONSOLIDADOR AKITA       │
      │  · Deduplica                │
      │  · Ranqueia                 │
      │  · Mínimo AGORA             │
      │  · Observação Futura        │
      └─────────────────────────────┘
                    │
                    ▼
         Relatório Final Estruturado
```

## Como Usar

### Revisar um PR do GitHub

```
@agent akita: https://github.com/org/repo/pull/123
```

Ou:

```
@agent akita: review this PR https://github.com/org/repo/pull/123
```

### Revisar um Plano

```
@agent akita: review this plan specs/005-something/plan.md
```

Ou:

```
@agent akita: analisa esse plano .sisyphus/plans/meu-plano.md
```

## Matriz de Personalidades

| Persona | Inspiração | Foco | Pega |
|---------|-----------|------|------|
| **Cético** | "Prove que funciona" | Corretude, edge cases | Bugs, race conditions, erros não tratados |
| **Minimalista** | "Comece pelo desejo" | Simplicidade, necessidade | Over-engineering, abstração prematura |
| **Arquiteto** | "Decisões estruturais" | Design, acoplamento | Boundaries, vazamento de responsabilidade |
| **Segurança** | "Todo input é hostil" | Safety, dados | Vulnerabilidades, secrets, exposição |
| **Eng. Produção** | "75% é hardening" | Production readiness | Testes, deploy, observabilidade, custos |
| **Consolidador** | Akita Boss (merge) | Síntese, priorização | Mínimo agora + evolução futura |

## Output

O relatório final inclui:

1. **Veredito**: PASS | CONTESTED | REJECT
2. **Resumo executivo**: contagem por severidade
3. **Achados consolidados**: cada um com `minimoAgora` e `observacaoFutura`
4. **Produção Readiness Checklist**: baseado no checklist do Akita
5. **Observações de Evolução Futura**: o que não precisa ser feito agora

## Exemplo de Output

```
## Akita Review Report
**Tipo:** PR
**Alvo:** https://github.com/org/repo/pull/123
**Veredito Final:** CONTESTED

### Resumo Executivo
- 1 crítico, 3 altos, 2 médios, 4 leves
- Produção readiness: 3/5 itens

### Achados Detalhados

#### 🔴 Crítico
**Jobs não idempotentes** (cético, produção)
`src/jobs/collector.ts:45`
- **Problema**: Se o job rodar duas vezes, duplica registros
- **Mínimo AGORA**: Adicionar `find_or_initialize_by(platform_post_id)`
- **Evolução Futura**: Considerar SNAPSHOT_DEDUP_WINDOW de 1h

### Produção Readiness Checklist
[ ] Tests coverage nas paths alteradas → PARCIAL (unit ok, falta integration)
[ ] Security audit → N/A (sem mudança de segurança)
[✓] Observabilidade → logs estruturados adicionados
...

### Observações de Evolução Futura
- Quando houver mais de 10 perfis, o discovery pipeline vai precisar
  de rate limiting por perfil
- A cost tracking de LLM pode ser adicionada como métrica no Prometheus
```

## Requisitos

- Acesso a `gh` (GitHub CLI) para baixar diffs de PR
- Ou acesso web para fetch de URLs de PR

## Inspiração

Esta skill é baseada nos artigos e princípios de [Fabio Akita](https://akitaonrails.com/):

- ["Vibe Code: Do Zero à Produção em 6 DIAS"](https://akitaonrails.com/2026/02/16/vibe-code-do-zero-a-producao-em-6-dias-the-m-akita-chronicles/)
- ["Eu Fiz um Sistema de Data Mining pra Minha Namorada Influencer"](https://akitaonrails.com/2026/03/04/eu-fiz-um-sistema-de-data-mining-pra-minha-namorada-influencer-dicas-e-truques/)
- [Production Readiness Checklist](../../wiki/wiki/concepts/production-readiness.md)

## Diferenças do eval-reviewer

| Aspecto | eval-reviewer | Akita |
|---------|-------------|-------|
| Engine | Script bun + qwen CLI | Sub-agentes Oracle via task() |
| Output | Findings puros | Mínimo agora + evolução futura |
| Escopo | Código apenas | Código + Planos |
| Lens | Genérico | Produção-primeiro (Akita) |
| Veredito | PASS/CONTESTED/REJECT | + Score de produção readiness |
| Inspiração | - | Fabio Akita, XP, 75% Rule |
