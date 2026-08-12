import React from "react";

interface Props {
  onError: (error: Error) => void;
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
}

/**
 * The core of M7's mandatory 2D fallback: catches any error thrown while
 * loading or rendering the 3D scene — a missing/unlinked native
 * `expo-gl` module, a GL context creation failure, anything — and
 * reports it up via `onError` instead of crashing the app. This is the
 * exact failure mode this account's previous Vite/Replit work hit with
 * unguarded WebGL detection (docs/architecture/01-repository-structure.md
 * §"Mobile 3D"); a plain try/catch around a synchronous capability check
 * is not enough because a broken native module throws during React's
 * render/commit, not at call time — only a class-component error
 * boundary catches that.
 */
export class ErrorBoundary3D extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}
