import "./App.css";

function App() {
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
              />

              <div className="prompt-actions">

                <button className="voice-button">
                  <span>⌁</span>
                </button>

                <button className="send-button">
                  ↑
                </button>

              </div>

            </div>

            <div className="prompt-footer">
              <span>Press Enter to send</span>
              <span>● AI ready</span>
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
