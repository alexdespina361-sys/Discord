import { renderMessage } from "./discord-preview.js";
import { readData } from "./lib.js";

for (const node of document.querySelectorAll("[data-discord-preview]")) {
  const data = readData(node.dataset.discordPreview);
  if (data?.message) node.replaceChildren(renderMessage(data.message, { names: data.names }));
}
