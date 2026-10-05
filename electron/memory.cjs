const fs = require("node:fs");
const path = require("node:path");

const memoryFile = path.join(
  __dirname,
  "..",
  "memory",
  "memory.json"
);

function loadMemory() {
  try {
    const data = fs.readFileSync(memoryFile, "utf8");
    return JSON.parse(data);
  } catch (error) {
    return { facts: [] };
  }
}

function saveMemory(memory) {
  fs.writeFileSync(
    memoryFile,
    JSON.stringify(memory, null, 2),
    "utf8"
  );
}

function addMemory(fact) {
  const memory = loadMemory();

  // Don't save duplicate memories
  const alreadyExists = memory.facts.some(
    (existingFact) =>
      existingFact.text.toLowerCase() === fact.text.toLowerCase()
  );

  if (!alreadyExists) {
    memory.facts.push(fact);
    saveMemory(memory);
  }

  return memory;
}

function getMemory() {
  return loadMemory();
}

module.exports = {
  loadMemory,
  saveMemory,
  addMemory,
  getMemory,
};