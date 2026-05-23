const featureList = [
  "Username/password auth with JWT sessions",
  "Room code and invite-link entry",
  "Realtime lobby with players and spectators",
  "Authoritative game flow with replay history"
];

export function App() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">The Resistance: Avalon</p>
        <h1>Private multiplayer deduction, built for the web.</h1>
        <p className="lede">
          Mobile-first rooms, live state over WebSockets, and an authoritative
          backend designed for 5 to 10 players.
        </p>
        <div className="actions">
          <button type="button">Create Account</button>
          <button type="button" className="secondary">
            Join Room
          </button>
        </div>
      </section>

      <section className="panel">
        <div>
          <p className="section-label">V1 Focus</p>
          <h2>Ship the core loop before adding social features.</h2>
        </div>
        <ul className="feature-list">
          {featureList.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </section>
    </main>
  );
}
