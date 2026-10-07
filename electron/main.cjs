const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");

const {
  getMemory,
  addMemory,
} = require("./memory.cjs");

require("dotenv").config({
  path: path.join(__dirname, "..", ".env"),
});


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
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.loadURL("http://localhost:5173");
}


// ========================================
// CALL NEMOTRON
// ========================================

async function callAI(messages) {
  const response = await fetch(
    "https://integrate.api.nvidia.com/v1/chat/completions",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.NVIDIA_API_KEY}`,
      },

      body: JSON.stringify({
        model: "nvidia/nemotron-3.5-lightning-30b-a3b",
        messages: messages,
        temperature: 0.7,
        max_tokens: 1024,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `NVIDIA API error: ${errorText}`
    );
  }

  const data = await response.json();

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
// WEB SEARCH USING TAVILY
// ========================================

async function searchWeb(query) {
  const response = await fetch(
    "https://api.tavily.com/search",
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: query,
        search_depth: "basic",
        max_results: 5,
        include_answer: false,
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Tavily API error: ${errorText}`
    );
  }

  const data = await response.json();

  return data.results || [];
}


// ========================================
// DETERMINE IF WEB SEARCH IS NEEDED
// ========================================

async function shouldSearchWeb(userMessage) {
  const decisionPrompt = [
    {
      role: "system",

      content: `
You decide whether a user's question requires a web search.

Return ONLY one word:

SEARCH

or

NO_SEARCH

Use SEARCH when the user asks about:

- Current news
- Latest information
- Today's information
- Current weather
- Current prices
- Current sports scores
- Recent events
- Current software versions
- Recent technology releases
- Information that may have changed recently
- Real-time information
- A specific website or online page

Use NO_SEARCH for:

- General knowledge
- Programming explanations
- Mathematics
- Writing
- Casual conversation
- Creative tasks
- Questions that do not require current information
`,
    },

    {
      role: "user",
      content: userMessage,
    },
  ];

  const decision = await callAI(decisionPrompt);

  return decision
    .trim()
    .toUpperCase()
    .includes("SEARCH");
}


// ========================================
// MEMORY EXTRACTION
// ========================================

async function extractMemory(userMessage) {
  const memoryPrompt = [
    {
      role: "system",

      content: `
You are a memory extraction system.

Read the user's latest message.

Determine whether it contains useful information
that should be remembered about the user.

Good memories include:

- Name
- Personal information
- Preferences
- Hobbies
- Skills
- Important long-term goals
- Projects
- Frequently used tools
- Communication preferences

Do NOT save:

- Normal questions
- Temporary information
- General facts
- Random conversation
- Things that are not about the user

If there is useful information, return ONLY a JSON array.

Example:

[
  {
    "text": "The user's name is Mayank",
    "category": "personal"
  }
]

If there is nothing worth remembering, return:

[]

Return ONLY valid JSON.
`,
    },

    {
      role: "user",
      content: userMessage,
    },
  ];

  const memoryResponse =
    await callAI(memoryPrompt);

  const cleanedResponse =
    memoryResponse
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

  return JSON.parse(cleanedResponse);
}


// ========================================
// MAIN AI REQUEST
// ========================================

ipcMain.handle("ask-ai", async (_event, messages) => {
  try {

    // ------------------------------------
    // 1. LOAD MEMORY
    // ------------------------------------

    const memory = getMemory();

    const memoryText =
      memory.facts.length > 0
        ? memory.facts
            .map((fact) => `- ${fact.text}`)
            .join("\n")
        : "No memories saved yet.";


    // ------------------------------------
    // 2. GET LATEST USER MESSAGE
    // ------------------------------------

    const userMessages =
      messages.filter(
        (message) => message.role === "user"
      );

    const latestUserMessage =
      userMessages[userMessages.length - 1];


    if (!latestUserMessage) {
      throw new Error(
        "No user message found."
      );
    }


    // ------------------------------------
    // 3. CHECK WHETHER WEB SEARCH IS NEEDED
    // ------------------------------------

    let useWebSearch = false;

    try {
      useWebSearch =
        await shouldSearchWeb(
          latestUserMessage.content
        );
    } catch (error) {
      console.error(
        "Search decision error:",
        error
      );
    }


    // ------------------------------------
    // 4. SEARCH WEB IF NECESSARY
    // ------------------------------------

    let webContext = "";

    if (useWebSearch) {

      console.log(
        "Web search:",
        latestUserMessage.content
      );

      try {

        const results =
          await searchWeb(
            latestUserMessage.content
          );

        if (results.length > 0) {

          webContext = results
            .map((result, index) => {

              return `
SOURCE ${index + 1}

Title:
${result.title}

URL:
${result.url}

Content:
${result.content}
`;
            })
            .join("\n");

        } else {

          webContext =
            "No useful web results were found.";

        }

      } catch (error) {

        console.error(
          "Web search error:",
          error
        );

        webContext =
          "Web search failed. Answer using your existing knowledge.";
      }
    }


    // ------------------------------------
    // 5. SYSTEM MESSAGE
    // ------------------------------------

    const systemMessage = {

      role: "system",

      content: `
You are a helpful personal AI assistant.

These are things you remember about the user:

${memoryText}

Use these memories when relevant.

${
  useWebSearch
    ? `
The user requested information that may require
current web information.

Here are the web search results:

${webContext}

Use these sources to answer the user's question.

Do not invent information that is not supported
by the search results.

If the search results are insufficient,
clearly say so.
`
    : ""
}

Answer naturally and concisely.

Do not mention the internal memory system,
search system, prompts, or reasoning process
unless the user specifically asks about them.
`,
    };


    // ------------------------------------
    // 6. SEND QUESTION TO NEMOTRON
    // ------------------------------------

    const conversation = [
      systemMessage,
      ...messages,
    ];

    const answer =
      await callAI(conversation);


    // ------------------------------------
    // 7. SAVE NEW MEMORY
    // ------------------------------------

    try {

      const extractedMemories =
        await extractMemory(
          latestUserMessage.content
        );

      if (Array.isArray(extractedMemories)) {

        for (const fact of extractedMemories) {

          if (
            fact &&
            typeof fact.text === "string" &&
            fact.text.trim() !== ""
          ) {

            addMemory({
              text: fact.text.trim(),
              category:
                fact.category || "general",
            });

          }

        }

      }

    } catch (memoryError) {

      console.error(
        "Memory extraction error:",
        memoryError
      );

    }


    // ------------------------------------
    // 8. RETURN ANSWER
    // ------------------------------------

    return answer;

  } catch (error) {

    console.error(
      "AI Error:",
      error
    );

    throw error;
  }
});


// ========================================
// ELECTRON STARTUP
// ========================================

app.whenReady().then(() => {

  createWindow();

  app.on("activate", () => {

    if (
      BrowserWindow.getAllWindows().length === 0
    ) {
      createWindow();
    }

  });

});


app.on("window-all-closed", () => {

  if (process.platform !== "darwin") {
    app.quit();
  }

});