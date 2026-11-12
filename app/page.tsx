import '../components/map/map.css';

import { Boot } from './Boot';

/** The map: markup for components/map/main.ts, which draws the films into #cv and wires the panels. */
export default function MapPage() {
  return (
    <>
      <canvas id="cv" aria-label="A map of films, grouped by kind. Search for a film, or click a dot to see the films most like it." />

      <div id="loading">
        <div>Loading movie map…</div>
        <div className="bar">
          <div />
        </div>
        <div id="loadnote" />
      </div>

      <div id="tooltip" hidden />

      <div id="controls">
        <div id="search-wrap" role="search">
          <span className="s-icon" aria-hidden="true">
            ⌕
          </span>
          <label className="sr-only" htmlFor="search">
            Search films, genres, keywords
          </label>
          <input
            id="search"
            type="text"
            placeholder="Search films, genres, keywords…"
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded="false"
            aria-controls="results"
          />
          <span className="kbd" aria-hidden="true">
            /
          </span>
          <div id="results" role="listbox" />
        </div>
        <div id="chips" />
        <div id="match-toggle">
          <span>Match</span>
          <div className="seg">
            <button id="mode-or" type="button" className="active">
              Any (OR)
            </button>
            <button id="mode-and" type="button">
              All (AND)
            </button>
          </div>
        </div>
        <div className="ctl-box collapsed" id="lang-box">
          <button className="ctl-head" type="button" aria-expanded="false">
            <span>Languages</span>
            <span className="caret">▾</span>
          </button>
          <div className="ctl-body">
            <div className="lang-actions">
              <button id="lang-all" type="button">
                All
              </button>
              <button id="lang-none" type="button">
                None
              </button>
            </div>
            <div id="lang-list" />
          </div>
        </div>
        <div className="ctl-box collapsed" id="kind-box">
          <button className="ctl-head" type="button" aria-expanded="false">
            <span id="kind-head">Kinds</span>
            <span className="caret">▾</span>
          </button>
          <div className="ctl-body" id="kind-list" />
        </div>
        <div id="counter" />
      </div>

      <nav id="zoom" className="box" aria-label="Zoom">
        <button id="z-in" type="button" aria-label="Zoom in">
          +
        </button>
        <button id="z-out" type="button" aria-label="Zoom out">
          −
        </button>
        <button id="z-fit" type="button" aria-label="Show the whole map">
          ⤢
        </button>
      </nav>

      <div id="hint">Scroll to zoom · Drag to pan · Click a film · Ctrl+K to ask · L labels · / search</div>

      <section id="detail" aria-label="Film details">
        <button className="d-close" id="d-close" type="button" aria-label="Close">
          ×
        </button>
        <div id="d-poster-wrap">
          <img id="d-poster" alt="" />
        </div>
        <div className="d-body">
          <h2 id="d-title" />
          <div className="d-meta" id="d-meta" />
          <div className="d-kind" id="d-kind" />
          <div className="d-chips" id="d-chips" />
          <div className="d-section">Overview</div>
          <div className="d-overview" id="d-overview" />
          <div className="d-actions">
            <button id="d-like" type="button" className="btn" aria-pressed="false">
              ♥ Like
            </button>
            <button id="d-dislike" type="button" className="btn" aria-pressed="false">
              ✕ Not for me
            </button>
            <a id="d-imdb" className="btn ghost" target="_blank" rel="noopener">
              IMDb ↗
            </a>
          </div>
          <p className="credit">
            <a href="https://www.themoviedb.org/" target="_blank" rel="noopener">
              <img src="/tmdb.svg" alt="TMDB" width={69} height={9} />
            </a>
            This product uses the TMDB API but is not endorsed or certified by TMDB.
          </p>
        </div>
      </section>

      <section id="panel" aria-label="Similar films">
        <button id="p-back" type="button" className="p-back" hidden>
          ← Chat results
        </button>
        <div className="p-title">
          <span id="p-title">Similar films</span>
          <span id="p-right">match</span>
        </div>
        <div id="p-sub" className="p-sub" hidden />
        <ol className="p-list" id="p-list" />
      </section>

      <section id="chat" className="box" aria-label="Ask for films">
        <div id="chat-top" hidden>
          <span id="chat-status" />
          <button id="chat-min" type="button" className="chat-min" aria-label="Collapse the chat">
            ▾
          </button>
        </div>
        <div id="chat-thread" role="log" aria-live="polite" hidden />
        <div id="chat-sugg" hidden />
        <div id="tray" hidden>
          <span className="lbl">Your picks</span>
          <span id="picks" />
          <button id="rec-go" type="button" className="go">
            Recommend 12 →
          </button>
        </div>
        <form id="chat-form" autoComplete="off">
          <label className="sr-only" htmlFor="chat-input">
            Ask for a film
          </label>
          <input id="chat-input" type="text" maxLength={500} placeholder="Ask for a film… e.g. a movie where a rich lifestyle is shown" />
          <button id="chat-clear" type="button" className="chat-clear" hidden>
            Clear
          </button>
          <button id="chat-send" type="submit" className="chat-send" aria-label="Send">
            ↑
          </button>
        </form>
      </section>

      <section id="error" hidden role="alert">
        <h2>The map data isn&apos;t here yet</h2>
        <p>
          Build it with <code>npm run data</code> (see the README), then refresh.
        </p>
      </section>

      <div id="live" className="sr-only" aria-live="polite" />

      <Boot />
    </>
  );
}
