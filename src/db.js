import { DatabaseSync } from "node:sqlite";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";

export const TABELAS = [
  "logs",
  "level",
  "events",
  "resources",
  "history_screens",
];

export function abrirBanco() {
  if (!process.env.DB_PATH) throw new Error("DB_PATH não configurado");

  const arquivo = path.resolve(process.env.DB_PATH);
  const devDir = path.resolve(process.env.DEV_DATA_DIR ?? "data/dev");

  // DEV só pode acessar bancos dentro de data/dev
  if (process.env.ETOMADA_ENV === "dev") {
    if (!arquivo.startsWith(devDir + path.sep))
      throw new Error(
        "Banco DEV [" + arquivo + "] fora do diretório permitido",
      );
  }

  if (!existsSync(arquivo)) throw new Error(`Banco inexistente: ${arquivo}`);

  const db = new DatabaseSync(arquivo, {
    readOnly: false,
    timeout: 2000,
  });

  try {
    const existentes = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => row.name),
    );

    for (const tabela of TABELAS) {
      if (!existentes.has(tabela)) throw new Error(`Tabela ausente: ${tabela}`);
    }

    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
