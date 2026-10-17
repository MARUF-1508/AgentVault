import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches render errors anywhere in the signed-in app so a single broken page
 * cannot leave a blank screen (important during a demo). The audit log and the
 * wallet itself are unaffected: everything sensitive happens server-side.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="card">
          <h1>Something broke in the interface</h1>
          <p className="muted">
            This is a UI error only — the policy engine, the audit log and your funds are untouched. The details below help fix it.
          </p>
          <pre className="mono small error-detail">{this.state.error.message}</pre>
          <div className="row">
            <button className="btn" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn ghost" onClick={() => window.location.reload()}>
              Reload the page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
