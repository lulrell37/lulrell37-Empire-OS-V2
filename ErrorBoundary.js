import { Component } from 'react';
import { reportError } from './ErrorBanner';

export default class ErrorBoundary extends Component {
  componentDidCatch(error, info) {
    reportError(`Render crash: ${error.message}`);
    console.log('Render error:', error, info);
  }
  render() {
    return this.props.children;
  }
}
