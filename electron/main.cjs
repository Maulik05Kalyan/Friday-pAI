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
// MAIN AI REQUEST
// ========================================

ipcMain.handle("ask-ai", async (_event, messages) => {

  try {

    // ------------------------------------
    // 1. LOAD EXISTING MEMORY
    // ------------------------------------

    const memory = getMemory();


    const memoryText =
      memory.facts.length > 0
        ? memory.facts
            .map((fact) => `- ${fact.text}`)
            .join("\n")
        : "No memories saved yet.";


    // ------------------------------------
    // 2. CREATE SYSTEM MESSAGE
    // ------------------------------------

    const systemMessage = {

      role: "system",

      content: `
You are a helpful personal AI assistant.

These are things you remember about the user:

${memoryText}

Use these memories when they are relevant.

Answer the user's question naturally and concisely.

Do not mention the memory system unless the user asks about it.
`,
    };


    // ------------------------------------
    // 3. SEND NORMAL QUESTION
    // ------------------------------------

    const conversation = [
      systemMessage,
      ...messages,
    ];


    const answer = await callAI(conversation);


    // ------------------------------------
    // 4. FIND THE LATEST USER MESSAGE
    // ------------------------------------

    const userMessages =
      messages.filter(
        (message) => message.role === "user"
      );


    const latestUserMessage =
      userMessages[userMessages.length - 1];


    // ------------------------------------
    // 5. ASK AI TO FIND MEMORY
    // ------------------------------------

    if (latestUserMessage) {

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

          content: latestUserMessage.content,
        },

      ];


      try {

        const memoryResponse =
          await callAI(memoryPrompt);


        // Remove possible markdown formatting
        const cleanedResponse =
          memoryResponse
            .replace(/```json/g, "")
            .replace(/```/g, "")
            .trim();


        const extractedMemories =
          JSON.parse(cleanedResponse);


        // --------------------------------
        // 6. SAVE MEMORIES
        // --------------------------------

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

        // Memory failure should NOT
        // break the normal AI response.

        console.error(
          "Memory extraction error:",
          memoryError
        );

      }

    }


    // ------------------------------------
    // 7. RETURN NORMAL AI ANSWER
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