import { useState } from "react";
import "./App.css";

function App() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [thinking, setThinking] = useState(false);

  async function sendMessage() {
    const text = message.trim();

    if (!text || thinking) return;

    // Add user's message to the chat
    const userMessage = {
      role: "user",
      content: text,
    };

    const updatedMessages = [...messages, userMessage];

    setMessages(updatedMessages);
    setMessage("");
    setThinking(true);

    try {
      // Send conversation to Electron → NVIDIA → Nemotron
      const reply = await window.electronAPI.askAI(updatedMessages);
      console.log("Frontend received reply:", reply);
      console.log("Frontend reply length:", reply?.length);

      const aiMessage = {
        role: "assistant",
        content: reply,
      };
      console.log("Adding assistant message to chat:", aiMessage);

      setMessages([...updatedMessages, aiMessage]);
    } catch (error) {
      console.error(error);

      setMessages([
        ...updatedMessages,
        {
          role: "assistant",
          content:
            "Sorry, I couldn't connect to the AI right now.",
        },
      ]);
    } finally {
      setThinking(false);
    }
  }

  function handleKeyDown(event) {
    if (event.key === "Enter") {
      sendMessage();
    }
  }

  return (
    <div className="assistant">

      {/* Top navigation */}
      <header className="top-nav">
        <div className="logo">
          <div className="logo-mark">✦</div>
          <span>Personal AI</span>
        </div>

        <div className="top-actions">
          <button className="top-button">History</button>
          <button className="top-button">Settings</button>
        </div>
      </header>

      {/* Main experience */}
      <main className="hero">

        <div className="hero-content">

          {messages.length === 0 ? (
            <>
              <p className="greeting">
                YOUR PERSONAL ASSISTANT
              </p>

              <h1>
                How can I
                <br />
                <span>help you today?</span>
              </h1>

              <p className="description">
                Ask me anything, get things done, or just
                have a conversation.
              </p>
            </>
          ) : (
            <div className="chat-container">

              <div className="messages">

                {messages.map((msg, index) => (
                  <div
                    key={index}
                    className={`chat-message ${
                      msg.role === "user"
                        ? "user"
                        : "ai"
                    }`}
                  >
                    {msg.content}
                  </div>
                ))}

                {thinking && (
                  <div className="chat-message ai">
                    Thinking...
                  </div>
                )}

              </div>

            </div>
          )}

          {/* AI visual */}
          <div className="ai-visual">

            <div className="glow glow-one"></div>
            <div className="glow glow-two"></div>

            <div className="orb">
              <div className="orb-inner"></div>
              <div className="orb-light"></div>
            </div>

          </div>

          {/* Input */}
          <div className="prompt-wrapper">

            <div className="prompt-box">

              <input
                type="text"
                placeholder="Ask your personal AI..."
                value={message}
                onChange={(event) =>
                  setMessage(event.target.value)
                }
                onKeyDown={handleKeyDown}
                disabled={thinking}
              />

              <div className="prompt-actions">

                <button className="voice-button">
                  <span>⌁</span>
                </button>

                <button
                  className="send-button"
                  onClick={sendMessage}
                  disabled={thinking}
                >
                  ↑
                </button>

              </div>

            </div>

            <div className="prompt-footer">
              <span>Press Enter to send</span>

              <span>
                ● {thinking ? "Thinking..." : "AI ready"}
              </span>
            </div>

          </div>

        </div>

      </main>

      {/* Bottom navigation */}
      <footer className="bottom-nav">

        <div className="footer-left">
          <span className="online-dot"></span>
          <span>Personal AI</span>
        </div>

        <div className="footer-right">
          <span>Private</span>
          <span>•</span>
          <span>Always available</span>
        </div>

      </footer>

    </div>
  );
}

export default App;
