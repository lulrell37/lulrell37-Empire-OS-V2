import { Component } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { reportError } from './ErrorBanner';
import { logCrash } from './src/services/crashLog';

const NAV_STATE_KEY = 'EMPIRE_OS_NAV_STATE_V1';

export default class ErrorBoundary extends Component {
  state = { err: null };

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(error, info) {
    reportError(`Render crash: ${error.message}`);
    logCrash('render', error && error.message, (error && error.stack) || (info && info.componentStack));
    console.log('Render error:', error, info);
  }

  reload = () => this.setState({ err: null });

  resetApp = async () => {
    try { await AsyncStorage.removeItem(NAV_STATE_KEY); } catch {}
    this.setState({ err: null });
  };

  render() {
    if (this.state.err) {
      return (
        <View style={s.wrap}>
          <Text style={s.title}>SOMETHING BROKE</Text>
          <ScrollView style={s.msgBox}>
            <Text style={s.msg}>{String((this.state.err && this.state.err.message) || this.state.err)}</Text>
          </ScrollView>
          <TouchableOpacity onPress={this.reload} style={s.primary}>
            <Text style={s.primaryT}>RELOAD</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={this.resetApp} style={s.ghost}>
            <Text style={s.ghostT}>RESET APP STATE</Text>
          </TouchableOpacity>
        </View>
      );
    }
    return this.props.children;
  }
}

const s = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: '#000', padding: 24, justifyContent: 'center' },
  title: { color: '#E8C98A', fontFamily: 'monospace', fontSize: 14, letterSpacing: 3, marginBottom: 14 },
  msgBox: { maxHeight: 220, marginBottom: 22 },
  msg: { color: '#888', fontFamily: 'monospace', fontSize: 11, lineHeight: 17 },
  primary: { backgroundColor: '#E8C98A', padding: 14, borderRadius: 6, alignItems: 'center', marginBottom: 10 },
  primaryT: { color: '#000', fontFamily: 'monospace', fontWeight: '700', letterSpacing: 2 },
  ghost: { borderWidth: 1, borderColor: '#333', padding: 14, borderRadius: 6, alignItems: 'center' },
  ghostT: { color: '#E05555', fontFamily: 'monospace', letterSpacing: 2 },
});
