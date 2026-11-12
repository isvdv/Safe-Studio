const fs = require("fs");
const path = require("path");
const { createLogger } = require("../utils/logger");

const log = createLogger("Eventos");

function registrarArquivo(filePath, carregados, client) {
  delete require.cache[require.resolve(filePath)];
  const eventModule = require(filePath);
  const fileLabel = path.basename(filePath);

  if (typeof eventModule.setClient === "function") {
    eventModule.setClient(client);
    carregados.push(`${fileLabel} -> setClient`);
    return;
  }

  if (typeof eventModule.execute === "function" && eventModule.name) {
    const listen = eventModule.once ? client.once.bind(client) : client.on.bind(client);
    listen(eventModule.name, async (...args) => {
      try {
        await eventModule.execute(...args, client);
      } catch (error) {
        log.error(`Falha no evento ${eventModule.name} (${fileLabel}):`, error);
      }
    });
    carregados.push(`${fileLabel} -> ${eventModule.name}`);
    return;
  }

  log.warn(`Arquivo ignorado (sem execute/name): ${fileLabel}`);
}

function listarArquivos(dir, carregados, client) {
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      listarArquivos(filePath, carregados, client);
      continue;
    }

    if (file.endsWith(".js")) {
      registrarArquivo(filePath, carregados, client);
    }
  }
}

function eventsHandler(client) {
  const eventsPath = path.resolve("./Events");
  const carregados = [];

  listarArquivos(eventsPath, carregados, client);
  client.loadedEvents = carregados;
  log.debug(`Eventos carregados: ${carregados.join(" | ")}`);
}

module.exports = eventsHandler;
