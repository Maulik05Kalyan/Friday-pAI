const { app, BrowserWindow, ipcMain } = require("electron");

const path = require("node:path");

// Memory
const {
  getMemory,
  addMemory,
} = require("./memory.cjs");

// Web search
const {
  webSearch,
} = require("../tools/websearch.cjs");

// Date and time
const {
  getDateTime,
} = require("../tools/dateTime.cjs");

// Calculator
const {
  calculate,
} = require("../tools/calculator.cjs");

// System information
const {
  getSystemInfo,
} = require("../tools/systemInfo.cjs");

// File and folder manager
const {
  resolvePath,
  readByName,
  openByName,
  listByName,
  infoByName,
} = require("../tools/fileManager.cjs");

// Load environment variables
require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});


// ========================================
// CONFIGURATION
// ========================================

const NVIDIA_MODEL =
  "nvidia/nemotron-3.5-lightning-30b-a3b";

const NVIDIA_ENDPOINT =
  "https://integrate.api.nvidia.com/v1/chat/completions";


// ========================================
// CREATE WINDOW
// ========================================

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,

    minWidth: 1000,
    minHeight: 700,

    webPreferences: {
      preload: path.join(
        __dirname,
        "preload.cjs"
      ),

      contextIsolation: true,
      nodeIntegration: false,

      // Required for the current Electron setup
      sandbox: false,
    },
  });

  win.loadURL(
    "http://localhost:5173"
  );
}


// ========================================
// CALL NEMOTRON
// ========================================

async function callAI(
  messages,
  options = {}
) {
  const body = {
    model: NVIDIA_MODEL,

    messages,

    temperature:
      options.temperature ?? 0.7,

    max_tokens:
      options.max_tokens ?? 1024,

    stream: false,
  };


  // Optional structured response mode
  if (options.response_format) {
    body.response_format =
      options.response_format;
  }


  // Optional Nemotron chat-template settings
  if (options.chat_template_kwargs) {
    body.chat_template_kwargs =
      options.chat_template_kwargs;
  }


  // Optional deterministic seed
  if (options.seed !== undefined) {
    body.seed = options.seed;
  }


  const response = await fetch(
    NVIDIA_ENDPOINT,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        Authorization:
          `Bearer ${process.env.NVIDIA_API_KEY}`,
      },

      body: JSON.stringify(body),
    }
  );


  if (!response.ok) {
    const errorText =
      await response.text();

    throw new Error(
      `NVIDIA API error: ${errorText}`
    );
  }


  const data =
    await response.json();


  const answer =
    data.choices?.[0]?.message?.content;


  if (!answer) {
    throw new Error(
      "NVIDIA returned an empty response."
    );
  }


  return answer;
}


// ========================================
// AI TOOL ROUTER
// ========================================
//
// Nemotron decides which tool is needed.
// JavaScript validates and executes it.
//
// Router output:
//
// {
//   "tool": "calculator",
//   "action": "calculate",
//   "input": "25 * 48"
// }
//
// ========================================

async function routeTool(
  messages
) {
  const recentMessages =
    messages.slice(-8);


  const conversationContext =
    recentMessages
      .map((message) => {
        return `${message.role.toUpperCase()}: ${message.content}`;
      })
      .join("\n");


  const routerPrompt = [
    {
      role: "system",

      content: `
You are the semantic tool router for a personal AI assistant.

Your ONLY job is to decide which tool should handle the user's latest request.

Do NOT answer the user.
Do NOT explain your decision.
Do NOT perform the task yourself.

Available tools:

1. web_search
Use when the user needs information from the internet or information that may have changed.

Use for:
- latest news
- current events
- current prices
- stock prices
- weather
- recent announcements
- recent software releases
- current versions
- current public information
- specific websites
- anything explicitly asking to search/look up online

Do NOT use for:
- normal general knowledge
- mathematics
- programming explanations
- writing
- casual conversation
- information already present in the conversation


2. date_time
Use when the user asks about the current local date or time.

Examples:
- What is today's date?
- What day is it?
- What time is it?
- What is the current date?


3. calculator
Use when the user needs mathematical calculation.

Examples:
- 25 * 48
- 20 percent of 500
- calculate 2^10
- (50 + 20) / 7
- solve a numerical expression

Do NOT use for conceptual mathematics questions such as:
- What is Newton's second law?
- Explain derivatives.
- What is the formula for force?

Those should be handled directly by the AI.


4. system_info
Use when the user asks about their computer or operating system.

Examples:
- What CPU do I have?
- How much RAM do I have?
- How much free memory is available?
- What operating system am I using?
- What architecture is my PC?
- What is my computer name?
- How long has my PC been running?
- What Node version am I using?
- Tell me everything about my computer.


5. file_manager
Use when the user wants to interact with local files or folders.

Possible actions:

open
- Open a file or folder with the normal Windows application.

read
- Read the contents of a file.

list
- Show the contents of a folder.

info
- Give information about a file or folder.

find
- Find a file or folder by name.

Examples:
- Open calculator.cjs.
- Read package.json.
- Show me what's inside the tools folder.
- Find memory.json.
- Open my Personal AI project.
- What files are in the tools folder?


6. none
Use when no tool is required.

Examples:
- Explain APIs.
- What is JavaScript?
- Tell me a joke.
- Help me write an email.
- What is the difference between let and const?
- Have a conversation with me.


IMPORTANT SEMANTIC RULES:

- Choose based on the user's meaning, NOT merely keywords.
- Consider the conversation context when resolving words such as "it", "that", "this file", or "there".
- If the user refers to a file mentioned earlier, use file_manager.
- If the user asks for information that can change with time, prefer web_search.
- If the user asks about their own computer, prefer system_info over web_search.
- If the user asks to calculate a number, use calculator.
- If the user asks for an explanation rather than a calculation, use none.
- Never use web_search when a local tool can answer the question.
- Never use calculator to answer conceptual questions.
- Never use system_info for general computer questions that are not about the user's machine.
- When uncertain between a tool and none, choose none.
- Never invent a tool.


RETURN FORMAT:

Return ONLY one valid JSON object.

It MUST contain exactly these keys:

{
  "tool": "one_of_the_available_tools",
  "action": "the_action_for_that_tool",
  "input": "the_argument_needed_by_that_tool"
}

Allowed tool values:

web_search
date_time
calculator
system_info
file_manager
none

Allowed actions:

web_search:
  search

date_time:
  get

calculator:
  calculate

system_info:
  get

file_manager:
  open
  read
  list
  info
  find

none:
  none

For tools that need no input, use an empty string.

Examples:

User: "What is the latest technology news?"

{
  "tool": "web_search",
  "action": "search",
  "input": "latest technology news"
}

User: "What is 2847 * 392?"

{
  "tool": "calculator",
  "action": "calculate",
  "input": "2847 * 392"
}

User: "How much RAM does my computer have?"

{
  "tool": "system_info",
  "action": "get",
  "input": "ram"
}

User: "Open calculator.cjs"

{
  "tool": "file_manager",
  "action": "open",
  "input": "calculator.cjs"
}

User: "Read package.json"

{
  "tool": "file_manager",
  "action": "read",
  "input": "package.json"
}

User: "What is today's date?"

{
  "tool": "date_time",
  "action": "get",
  "input": ""
}

User: "Explain what an API is."

{
  "tool": "none",
  "action": "none",
  "input": ""
}

ABSOLUTE OUTPUT RULE:
Return JSON only.
No markdown.
No reasoning.
No explanation.
No text before or after the JSON.
`,
    },

    {
      role: "user",

      content: `
Conversation context:

${conversationContext}

Now classify the user's latest request.

Return only the required JSON object.
`,
    },
  ];


  try {
    // First attempt:
    // Structured JSON + thinking disabled.
    const routerResponse =
      await callAI(
        routerPrompt,
        {
          temperature: 0,
          max_tokens: 180,

          response_format: {
            type: "json_object",
          },

          chat_template_kwargs: {
            enable_thinking: false,
          },

          // Best-effort deterministic sampling
          seed: 42,
        }
      );


    console.log(
      "Raw tool router response:",
      routerResponse
    );


    return parseToolDecision(
      routerResponse
    );
  } catch (error) {
    console.error(
      "Tool router error:",
      error
    );

    // Fail safely.
    // We prefer using no tool rather than
    // executing the wrong tool.
    return {
      tool: "none",
      action: "none",
      input: "",
    };
  }
}


// ========================================
// PARSE + VALIDATE TOOL DECISION
// ========================================

function parseToolDecision(
  routerResponse
) {
  let cleanedResponse =
    routerResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();


  const firstBrace =
    cleanedResponse.indexOf("{");

  const lastBrace =
    cleanedResponse.lastIndexOf("}");


  if (
    firstBrace === -1 ||
    lastBrace === -1 ||
    lastBrace <= firstBrace
  ) {
    throw new Error(
      "Router did not return a JSON object."
    );
  }


  cleanedResponse =
    cleanedResponse.slice(
      firstBrace,
      lastBrace + 1
    );


  let decision;

  try {
    decision =
      JSON.parse(cleanedResponse);
  } catch {
    throw new Error(
      "Router returned invalid JSON."
    );
  }


  const validTools = [
    "web_search",
    "date_time",
    "calculator",
    "system_info",
    "file_manager",
    "none",
  ];


  if (
    !validTools.includes(
      decision.tool
    )
  ) {
    throw new Error(
      `Unknown tool: ${decision.tool}`
    );
  }


  const allowedActions = {
    web_search: [
      "search",
    ],

    date_time: [
      "get",
    ],

    calculator: [
      "calculate",
    ],

    system_info: [
      "get",
    ],

    file_manager: [
      "open",
      "read",
      "list",
      "info",
      "find",
    ],

    none: [
      "none",
    ],
  };


  if (
    !allowedActions[
      decision.tool
    ].includes(decision.action)
  ) {
    throw new Error(
      `Invalid action "${decision.action}" for tool "${decision.tool}".`
    );
  }


  if (
    typeof decision.input !==
    "string"
  ) {
    throw new Error(
      "Tool input must be a string."
    );
  }


  const normalizedDecision = {
    tool: decision.tool,
    action: decision.action,
    input:
      decision.input.trim(),
  };


  // Validate required input
  if (
    normalizedDecision.tool !==
    "none" &&
    normalizedDecision.tool !==
    "date_time" &&
    !normalizedDecision.input
  ) {
    throw new Error(
      "Selected tool requires an input."
    );
  }


  console.log(
    "Validated tool decision:",
    normalizedDecision
  );


  return normalizedDecision;
}


// ========================================
// FORMAT WEB RESULTS
// ========================================

function formatWebResults(
  results
) {
  if (
    !results ||
    results.length === 0
  ) {
    return (
      "No useful web results were found."
    );
  }


  return results
    .map(
      (result, index) => {
        return `
SOURCE ${index + 1}

Title:
${result.title}

URL:
${result.url}

Content:
${result.content}
`;
      }
    )
    .join("\n");
}


// ========================================
// FORMAT TOOL RESULT
// ========================================

function formatToolResult(
  toolDecision,
  result
) {
  if (
    toolDecision.tool ===
    "calculator"
  ) {
    return `Calculator result: ${result}`;
  }


  if (
    toolDecision.tool ===
    "date_time"
  ) {
    return JSON.stringify(
      result,
      null,
      2
    );
  }


  if (
    toolDecision.tool ===
    "system_info"
  ) {
    return JSON.stringify(
      result,
      null,
      2
    );
  }


  if (
    toolDecision.tool ===
    "file_manager"
  ) {
    if (
      typeof result ===
      "string"
    ) {
      return result;
    }

    return JSON.stringify(
      result,
      null,
      2
    );
  }


  return String(result);
}


// ========================================
// SENSITIVE FILE PROTECTION
// ========================================
//
// Do not send secrets such as API keys
// to the NVIDIA API through file contents.
//

function isSensitiveFile(
  target
) {
  const normalized =
    target
      .toLowerCase()
      .replace(/\\/g, "/");


  const fileName =
    path.basename(normalized);


  const sensitiveNames = [
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    "credentials.json",
    "secrets.json",
    "id_rsa",
    "id_ed25519",
  ];


  if (
    sensitiveNames.includes(
      fileName
    )
  ) {
    return true;
  }


  const sensitiveExtensions = [
    ".pem",
    ".key",
    ".p12",
    ".pfx",
  ];


  if (
    sensitiveExtensions.some(
      (extension) =>
        fileName.endsWith(
          extension
        )
    )
  ) {
    return true;
  }


  return false;
}


// ========================================
// EXECUTE TOOL
// ========================================

async function executeTool(
  toolDecision
) {
  switch (
  toolDecision.tool
  ) {

    // ------------------------------------
    // WEB SEARCH
    // ------------------------------------

    case "web_search": {
      console.log(
        "Running web search:",
        toolDecision.input
      );


      try {
        const results =
          await webSearch(
            toolDecision.input
          );


        return {
          success: true,

          result:
            formatWebResults(
              results
            ),
        };
      } catch (error) {
        console.error(
          "Web search error:",
          error
        );


        return {
          success: false,

          result:
            "Web search failed. Do not pretend that current web information was retrieved.",
        };
      }
    }


    // ------------------------------------
    // DATE / TIME
    // ------------------------------------

    case "date_time": {
      try {
        const result =
          getDateTime();


        return {
          success: true,

          result:
            formatToolResult(
              toolDecision,
              result
            ),
        };
      } catch (error) {
        return {
          success: false,

          result:
            `Date/time tool failed: ${error.message}`,
        };
      }
    }


    // ------------------------------------
    // CALCULATOR
    // ------------------------------------

    case "calculator": {
      try {
        const result =
          calculate(
            toolDecision.input
          );


        return {
          success: true,

          result:
            formatToolResult(
              toolDecision,
              result
            ),
        };
      } catch (error) {
        return {
          success: false,

          result:
            `Calculator error: ${error.message}`,
        };
      }
    }


    // ------------------------------------
    // SYSTEM INFO
    // ------------------------------------

    case "system_info": {
      try {
        const result =
          getSystemInfo(
            toolDecision.input ||
            "all"
          );


        return {
          success: true,

          result:
            formatToolResult(
              toolDecision,
              result
            ),
        };
      } catch (error) {
        return {
          success: false,

          result:
            `System information error: ${error.message}`,
        };
      }
    }


    // ------------------------------------
    // FILE MANAGER
    // ------------------------------------

    case "file_manager": {
      try {
        const target =
          toolDecision.input;


        // --------------------------------
        // FIND
        // --------------------------------

        if (
          toolDecision.action ===
          "find"
        ) {
          const resolvedPath =
            resolvePath(target);


          return {
            success: true,

            result:
              `Found "${target}" at:\n${resolvedPath}`,
          };
        }


        // --------------------------------
        // READ
        // --------------------------------

        if (
          toolDecision.action ===
          "read"
        ) {
          if (
            isSensitiveFile(
              target
            )
          ) {
            return {
              success: false,

              result:
                "For privacy and security, I won't send sensitive credential files to the AI model.",
            };
          }


          const content =
            readByName(target);


          return {
            success: true,

            result:
              content,
          };
        }


        // --------------------------------
        // OPEN
        // --------------------------------

        if (
          toolDecision.action ===
          "open"
        ) {
          const result =
            openByName(
              target
            );


          return {
            success: true,

            result:
              `Opened "${target}".\n${JSON.stringify(
                result,
                null,
                2
              )}`,
          };
        }


        // --------------------------------
        // LIST
        // --------------------------------

        if (
          toolDecision.action ===
          "list"
        ) {
          const result =
            listByName(
              target
            );


          return {
            success: true,

            result:
              JSON.stringify(
                result,
                null,
                2
              ),
          };
        }


        // --------------------------------
        // INFO
        // --------------------------------

        if (
          toolDecision.action ===
          "info"
        ) {
          const result =
            infoByName(
              target
            );


          return {
            success: true,

            result:
              JSON.stringify(
                result,
                null,
                2
              ),
          };
        }


        return {
          success: false,

          result:
            "Unknown file manager action.",
        };
      } catch (error) {
        console.error(
          "File manager error:",
          error
        );


        return {
          success: false,

          result:
            `File manager error: ${error.message}`,
        };
      }
    }


    // ------------------------------------
    // NONE
    // ------------------------------------

    case "none":
    default: {
      return {
        success: true,
        result:
          "No tool was required.",
      };
    }
  }
}


// ========================================
// MEMORY EXTRACTION
// ========================================

async function extractMemory(
  userMessage
) {
  const memoryPrompt = [
    {
      role: "system",

      content: `
You are a memory extraction system.

Read only the user's latest message.

Determine whether it contains useful long-term information about the user that should be remembered.

Good memories include:
- name
- personal information
- preferences
- hobbies
- skills
- important long-term goals
- projects
- frequently used tools
- communication preferences

Do NOT save:
- normal questions
- temporary information
- general facts
- random conversation
- information that is not about the user

Return ONLY this JSON object:

{
  "memories": []
}

If there are useful memories:

{
  "memories": [
    {
      "text": "The user's name is Mayank",
      "category": "personal"
    }
  ]
}

Do not include explanations.
Do not include markdown.
Return JSON only.
`,
    },

    {
      role: "user",

      content: userMessage,
    },
  ];


  const memoryResponse =
    await callAI(
      memoryPrompt,
      {
        temperature: 0,
        max_tokens: 300,

        response_format: {
          type: "json_object",
        },

        chat_template_kwargs: {
          enable_thinking: false,
        },

        seed: 42,
      }
    );


  const cleanedResponse =
    memoryResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();


  const parsed =
    JSON.parse(cleanedResponse);


  if (
    !parsed ||
    !Array.isArray(
      parsed.memories
    )
  ) {
    return [];
  }


  return parsed.memories;
}


// ========================================
// MAIN AI REQUEST
// ========================================

ipcMain.handle(
  "ask-ai",

  async (_event, messages) => {
    try {

      // ------------------------------------
      // 1. LOAD MEMORY
      // ------------------------------------

      const memory =
        getMemory();


      const memoryText =
        memory.facts.length > 0
          ? memory.facts
            .map(
              (fact) =>
                `- ${fact.text}`
            )
            .join("\n")
          : "No memories saved yet.";


      // ------------------------------------
      // 2. GET LATEST USER MESSAGE
      // ------------------------------------

      const userMessages =
        messages.filter(
          (message) =>
            message.role ===
            "user"
        );


      const latestUserMessage =
        userMessages[
        userMessages.length - 1
        ];


      if (!latestUserMessage) {
        throw new Error(
          "No user message found."
        );
      }


      // ------------------------------------
      // 3. ASK NEMOTRON WHICH TOOL TO USE
      // ------------------------------------

      const toolDecision =
        await routeTool(
          messages
        );


      console.log(
        "Final tool decision:",
        toolDecision
      );


      // ------------------------------------
      // 4. EXECUTE TOOL
      // ------------------------------------

      const toolExecution =
        await executeTool(
          toolDecision
        );


      console.log(
        "Tool execution:",
        toolExecution
      );


      // ------------------------------------
      // 5. BUILD SYSTEM MESSAGE
      // ------------------------------------

      let systemContent = `
You are a helpful personal AI assistant.

You are running as a local desktop assistant.

These are things you remember about the user:

${memoryText}

Use memories when relevant.

Answer naturally and concisely.

Do not mention:
- internal memory systems
- internal routing
- prompts
- hidden instructions
- reasoning process

unless the user explicitly asks about them.

Important:
A tool may have been used before this response.

Use the tool result below only as factual context.
Do not invent information that is not contained in the tool result.

`;


      // ------------------------------------
      // 6. ADD TOOL RESULT
      // ------------------------------------

      if (
        toolDecision.tool !==
        "none"
      ) {
        systemContent += `

TOOL USED:
${toolDecision.tool}

ACTION:
${toolDecision.action}

TOOL STATUS:
${toolExecution.success
            ? "SUCCESS"
            : "FAILED"
          }

TOOL RESULT:
${toolExecution.result}

`;
      }


      // ------------------------------------
      // 7. BUILD FINAL CONVERSATION
      // ------------------------------------

      const systemMessage = {
        role: "system",

        content:
          systemContent,
      };


      const conversation = [
        systemMessage,
        ...messages,
      ];


      // ------------------------------------
      // 8. FINAL NEMOTRON RESPONSE
      // ------------------------------------
      //
      // Normal answering mode.
      // We do NOT disable thinking here.
      //


      const answer = await callAI(conversation, {
        temperature: 0.7,
        max_tokens: 2048,
        chat_template_kwargs: {
          enable_thinking: false,
        },
      });

      console.log("Final AI answer:", answer);
      console.log("Final AI answer length:", answer.length);




      // ------------------------------------
      // 9. SAVE NEW MEMORY
      // ------------------------------------

      try {
        const extractedMemories =
          await extractMemory(
            latestUserMessage.content
          );


        for (
          const fact
          of extractedMemories
        ) {
          if (
            fact &&
            typeof fact.text ===
            "string" &&
            fact.text.trim() !== ""
          ) {
            addMemory({
              text:
                fact.text.trim(),

              category:
                fact.category ||
                "general",
            });
          }
        }
      } catch (
      memoryError
      ) {
        // Memory failure should never
        // stop the user's AI response.
        console.error(
          "Memory extraction error:",
          memoryError
        );
      }


      // ------------------------------------
      // 10. RETURN ANSWER
      // ------------------------------------

      return answer;

    } catch (error) {

      console.error(
        "AI Error:",
        error
      );

      throw error;
    }
  }
);


// ========================================
// ELECTRON STARTUP
// ========================================

app.whenReady().then(() => {
  createWindow();


  app.on(
    "activate",
    () => {
      if (
        BrowserWindow
          .getAllWindows()
          .length === 0
      ) {
        createWindow();
      }
    }
  );
});


app.on(
  "window-all-closed",
  () => {
    if (
      process.platform !==
      "darwin"
    ) {
      app.quit();
    }
  }
);