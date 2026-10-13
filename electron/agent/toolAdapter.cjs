
const fs = require("node:fs");
const path = require("node:path");

require("dotenv").config({
  path: path.resolve(__dirname, "../../.env"),
});

const { executeTool } = require("./toolRegistry.cjs");
const { loadWorkflow } = require("./workflowEngine.cjs");

const NVIDIA_URL =
  "https://integrate.api.nvidia.com/v1/chat/completions";

const NVIDIA_MODEL = "nvidia/nemotron-3.5-lightning-30b-a3b";

const SUPPORTED_TOOLS = new Set([
  "calculator",
  "date_time",
  "system_info",
  "web_search",
  "file_manager",
  "llm_summarize",
  "llm_plan",
  "llm_explain",
  "llm_verify_calculation",
  "llm_format_notes",
  "save_notes",
]);

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }

  return value.trim();
}

async function callNVIDIA(systemPrompt, userPrompt) {
  if (!process.env.NVIDIA_API_KEY) {
    throw new Error("NVIDIA_API_KEY is missing from .env.");
  }

  const response = await fetch(NVIDIA_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: NVIDIA_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.3,
      max_tokens: 1200,
      chat_template_kwargs: {
        enable_thinking: false,
      },
    }),
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `NVIDIA API error (${response.status}): ${errorText.slice(0, 500)}`
    );
  }

  const data = await response.json();
  const answer = data.choices?.[0]?.message?.content;

  if (typeof answer !== "string" || !answer.trim()) {
    throw new Error("NVIDIA returned an empty response.");
  }

  return answer.trim();
}

function mapToolArguments(definition, context) {
  const inputs = context.inputs || {};

  switch (definition.tool) {
    case "calculator":
      return {
        expression: requireString(inputs.expression, "Expression"),
      };

    case "date_time":
      return {};

    case "system_info":
      return {
        query:
          typeof inputs.check === "string" && inputs.check.trim()
            ? inputs.check.trim()
            : "all",
      };

    case "web_search": {
      let query = inputs.query;

      if (!query && inputs.topic) {
        query = [inputs.topic, inputs.focus]
          .filter(value => typeof value === "string" && value.trim())
          .join(" ");
      }

      if (!query && Array.isArray(inputs.topics)) {
        query = inputs.topics.join(", ");
      }

      if (!query) query = inputs.goal;

      return {
        query: requireString(query, "Search query"),
      };
    }

    case "file_manager": {
      const action = definition.action || "list";
      const previousResults = context.previousResults || {};
      const basePath =
        inputs.directory ?? inputs.projectPath ?? inputs.path ?? ".";

      if (action === "list") {
        return {
          action,
          path: requireString(basePath, "Directory"),
        };
      }

      if (action === "find") {
        return {
          action,
          path: requireString(basePath, "Directory"),
          fileName: requireString(
            inputs.fileName ?? definition.fileName,
            "File name"
          ),
        };
      }

      if (action === "info") {
        const listedFiles = previousResults.list_files;

        if (Array.isArray(listedFiles)) {
          const blockedNames = new Set([
            ".env",
            ".env.local",
            ".env.production",
            ".env.development",
            "credentials.json",
            "secrets.json",
            "id_rsa",
            "id_ed25519",
          ]);

          const safeFiles = listedFiles.filter(item => {
            if (!item || typeof item.path !== "string") {
              return false;
            }

            const name = String(item.name || "").toLowerCase();

            return (
              !blockedNames.has(name) &&
              !/^\.env(?:\.|$)/i.test(name) &&
              !/\.(pem|key|p12|pfx)$/i.test(name)
            );
          });

          const firstFile = safeFiles.find(item => item.type === "file");

          if (firstFile) {
            return {
              action: "info",
              path: firstFile.path,
            };
          }

          throw new Error("No safe files were found to inspect.");
        }

        return {
          action,
          path: requireString(
            inputs.filePath ?? definition.path,
            "File path"
          ),
        };
      }

      if (action === "read") {
        return {
          action,
          path: requireString(
            inputs.filePath ?? definition.path,
            "File path"
          ),
        };
      }

      throw new Error(`Unsupported file action: ${action}`);
    }

    default:
      throw new Error(`No argument mapping for tool: ${definition.tool}`);
  }
}

async function executeAITool(toolName, context) {
  const inputs = context.inputs || {};
  const previousResults = context.previousResults || {};

  const systemPrompts = {
    llm_summarize:
      "Summarize the supplied information accurately. Organize it with headings and key points. Do not invent facts or claim that unverified information is confirmed.",

    llm_plan:
      "Act as a careful project assistant. Create a practical, ordered plan based on the supplied goal and evidence. Clearly distinguish recommendations from facts. Do not claim to have changed any files.",

    llm_explain:
      "Explain the supplied calculation and its result in beginner-friendly language. Show the relevant steps. Do not change the calculated result.",

    llm_verify_calculation:
      "Independently check the supplied calculation. Explain whether the result appears correct. If the expression or evidence is insufficient, say so. Do not silently replace the calculator's result.",

    llm_format_notes:
      "Turn the supplied research into clear, organized study notes with headings, key findings, and useful takeaways. Preserve factual accuracy and mention gaps in the evidence.",
  };

  const prompt = [
    `Workflow: ${context.workflowId}`,
    `Task: ${toolName}`,
    `User inputs:\n${JSON.stringify(inputs, null, 2)}`,
    `Previous step results:\n${JSON.stringify(previousResults, null, 2)}`,
    "Complete this task using only the supplied context and your knowledge. Be clear about uncertainty.",
  ].join("\n\n");

  const answer = await callNVIDIA(systemPrompts[toolName], prompt);

  return {
    success: true,
    data: answer,
  };
}

async function executeWorkflowTool(toolName, context = {}) {
  try {
    if (!SUPPORTED_TOOLS.has(toolName)) {
      throw new Error(`Tool is not implemented: ${toolName}`);
    }

    if (!context.workflowId || !context.stepId) {
      throw new Error("Workflow ID and step ID are required.");
    }

    const workflow = loadWorkflow(context.workflowId);

    const definition = workflow.steps.find(
      step => step.id === context.stepId
    );

    if (!definition || definition.tool !== toolName) {
      throw new Error(
        "Workflow step definition does not match the requested tool."
      );
    }

    if (toolName === "save_notes") {
      const notes = context.previousResults?.organize_notes;

      if (typeof notes !== "string" || !notes.trim()) {
        throw new Error("No research notes are available to save.");
      }

      const topic = String(context.inputs?.topic || "research");
      const slug =
        topic
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60) || "research";

      const notesDirectory = path.resolve(
        __dirname,
        "../../data/notes"
      );

      fs.mkdirSync(notesDirectory, { recursive: true });

      const filePath = path.join(
        notesDirectory,
        `${slug}-${Date.now()}.md`
      );

      fs.writeFileSync(
        filePath,
        `# Research Notes: ${topic}\n\n${notes.trim()}\n`,
        { encoding: "utf8", flag: "wx" }
      );

      return {
        success: true,
        data: {
          message: "Research notes saved successfully.",
          filePath: path.relative(
            path.resolve(__dirname, "../.."),
            filePath
          ),
        },
      };
    }

    if (toolName.startsWith("llm_")) {
      return await executeAITool(toolName, context);
    }

    const args = mapToolArguments(definition, context);
    const result = await executeTool(toolName, args);

    if (!result || result.success !== true) {
      throw new Error(result?.error || `${toolName} failed.`);
    }

    return {
      success: true,
      data: result.result,
    };
  } catch (error) {
    return {
      success: false,
      tool: toolName,
      error: error.message || "Workflow tool execution failed.",
    };
  }
}

module.exports = {
  mapToolArguments,
  executeWorkflowTool,
};



