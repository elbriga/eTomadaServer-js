import { DatabaseSync } from "node:sqlite";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import path from "node:path";
import { inicializarSchema } from "./schema.js";

export { TABELAS } from "./schema.js";

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
    db.exec("PRAGMA foreign_keys = ON");
    inicializarSchema(db);
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}
