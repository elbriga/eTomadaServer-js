# Orientações para agentes

## Escopo e projeto

Estas orientações valem para todo o repositório. Responda em português e siga as convenções dos arquivos alterados.

O eTomadaServer administra nodos e recursos de automação: descoberta, snapshots, eventos, comandos de relés, grupos, regras, histórico e alertas Telegram. O backend usa JavaScript ESM, Fastify 5 e SQLite nativo (`node:sqlite`). O frontend é HTML, CSS e JavaScript servido diretamente pelo backend, sem bundler.

## Mapa do código

- `src/server.js`: entrada real da aplicação; configura autenticação, banco, serviços, rotas, arquivos estáticos e encerramento. O campo `main` de `package.json` não representa a entrada usada pelo script de desenvolvimento.
- `src/routes/`: plugins Fastify com endpoints `/api/*`, validação por JSON Schema e tratamento de erros HTTP.
- `src/repositories/`: persistência e consultas SQLite.
- `src/schema.js`: criação, validação e evolução do esquema; contém `SCHEMA_VERSION` e `TABELAS`.
- `src/db.js`: abertura do banco existente, ativação de chaves estrangeiras e restrição do caminho do banco em desenvolvimento.
- `src/services/`: monitoramento de nodos, execução de comandos, grupos, regras globais, timers, agendador, sincronização de regras locais, recuperação e alertas.
- `src/devices/`: transporte HTTP para os nodos e sincronização de regras; preserve os contratos das APIs Full e Lite.
- `src/auth.js` e `src/sse.js`: autenticação e atualizações via Server-Sent Events.
- `public/` e `public/static/`: páginas e seus scripts/estilos; altere os arquivos diretamente.
- `test/`: testes com `node:test`, `node:assert/strict`, SQLite em memória e Fastify `inject()`.
- `scripts/`: clientes shell para consultar a API, com endereços fixos; confira o destino antes de executar.
- `config/etomada@.service` e `upgrade.sh`: operação via systemd e atualização de produção.

## Ambiente e comandos

Use uma versão de Node.js compatível com `node:sqlite` e `--env-file`. O repositório não fixa `engines`; o ambiente analisado usa Node.js 22.22.1.

```sh
npm ci
npm test
node --test test/resourceRoutes.test.js
npm run dev
```

- `npm ci` instala conforme `package-lock.json`.
- `npm test` executa `node --test`. Para uma alteração localizada, execute primeiro os arquivos de teste relacionados.
- `npm run dev` executa `node --env-file=.env.dev src/server.js`. Não há scripts de build, lint ou formatação definidos.
- Use `.env.dev.sample` como referência de variáveis, sem sobrescrever um `.env.dev` existente. O exemplo habilita comandos físicos e modos `execute`; revise esses valores antes de iniciar qualquer servidor.
- Configure `ETOMADA_ENV=dev`, `HOST`, `PORT` e `DB_PATH`. O arquivo SQLite precisa existir; `abrirBanco()` não cria um banco ausente. Em desenvolvimento, ele deve ficar dentro de `DEV_DATA_DIR` (padrão: `data/dev`). Para testes, prefira `DatabaseSync(":memory:")` e `inicializarSchema(db)`.
- Outras integrações usam `WEB_AUTH_USERNAME`, `WEB_AUTH_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` e `WHISPER_URL`; consulte os respectivos módulos antes de alterá-las.

## Cuidados com execução e dados

- Prefira testes isolados para validar mudanças. Iniciar `src/server.js` também inicia monitoramento e pode acessar nodos e serviços reais.
- Para desenvolvimento isolado, mantenha `ENABLE_PHYSICAL_COMMANDS=false`, `RULE_ENGINE_MODE=off`, `RULE_SYNC_MODE=off` e `RECOVERY_AUTO_REBOOT=false`. Simulações de regras usam o modo `simulate`.
- `RULE_ENGINE_MODE` e `RULE_SYNC_MODE` aceitam `off`, `simulate` e `execute`, com controles independentes. `RULE_ENGINE_MODE=execute` exige comandos físicos habilitados; não suponha que essa mesma trava proteja a sincronização local.
- `RULE_SYNC_NODE` restringe a sincronização a um nodo. `DEV_COMMAND_NODE` restringe o reboot de recuperação em desenvolvimento; não é uma lista de permissão geral para comandos de relés.
- Não execute `upgrade.sh` como validação: ele atualiza o checkout, instala dependências e reinicia o serviço de produção. Não acione hardware nem altere produção sem isso fazer parte da tarefa autorizada.
- Não versionar bancos, backups, `node_modules/` ou arquivos `.env.dev`/`.env.prod`. Não exponha credenciais em código, logs, testes ou respostas.
- Preserve a autenticação registrada antes das rotas e plugins HTTP. Atualmente, o hook exige Basic Auth para requisições com `cf-connecting-ip`, e produção exige credenciais configuradas; não presuma autenticação obrigatória para toda requisição local.

## Convenções para alterações

- Use ESM (`import`/`export`) com extensão `.js` nos imports relativos. Siga a indentação de dois espaços, aspas duplas e ponto e vírgula dos arquivos existentes.
- Preserve a nomenclatura mista existente: funções e mensagens frequentemente em português, módulos e campos de protocolo frequentemente em inglês. Evite renomeações abrangentes sem necessidade.
- Mantenha validação HTTP nas rotas, lógica de negócio nos serviços, SQL nos repositórios e comunicação com hardware em `devices/`. Preserve injeção de dependências para transportes, relógios e callbacks nos testes.
- Use parâmetros vinculados em SQL. Mudanças de esquema devem seguir as migrações de `src/schema.js`, atualizar a versão quando necessário e preservar bancos existentes e dados administrativos.
- Preserve a distinção entre estado desejado e estado reportado pelo dispositivo. Um envio HTTP não confirma por si só o estado físico; mantenha o histórico de comandos e os estados de incerteza e reconciliação.
- Ao alterar monitoramento ou comandos, considere snapshots antigos, eventos concorrentes, exclusão mútua por relé e reinicialização do nodo. Use os testes de corrida e ciclo de comandos como referência.
- Ao alterar regras, considere separadamente motor global e sincronização local, cancelamento de timers, reconciliação de boot e proteção contra loops. O agendador usa `America/Sao_Paulo` explicitamente.
- Serviços com timers ou tarefas pendentes devem permitir encerramento e liberar recursos. Preserve os hooks de fechamento; nos testes, feche Fastify e SQLite e restaure mocks.
- Preserve contratos de endpoints, identificadores físicos e globais e payloads de firmware. Atualize os consumidores do frontend quando mudar um contrato da API.

## Validação e entrega

Para alterações de comportamento, ajuste ou acrescente testes que verifiquem o resultado observável, usando banco em memória e transportes simulados. Evite acesso a nodos, Telegram ou bancos reais nos testes.

Execute os testes pertinentes e, para alterações que atravessem serviços, rotas ou persistência, execute `npm test`. Para mudanças apenas de documentação, confira o conteúdo e o diff. Não introduza ferramentas de build ou formatação sem necessidade da tarefa.

Ao concluir, informe o que mudou, como foi validado e eventuais limitações. Não declare testes como aprovados se não foram executados.
