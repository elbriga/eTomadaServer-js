import { DatabaseSync } from "node:sqlite";
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

  // DEV só pode acessar bancos dentro de data/dev
  if (process.env.ETOMADA_ENV === "dev") {
    const devDir = path.resolve("data/dev") + path.sep;

    if (!arquivo.startsWith(devDir))
      throw new Error("Banco DEV fora do diretório permitido");
  }

  const db = new DatabaseSync(arquivo, {
    readOnly: true,
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
