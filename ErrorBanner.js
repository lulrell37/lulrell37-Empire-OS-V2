import { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';

let listeners = [];
export const reportError = (message) => {
  listeners.forEach((fn) => fn(message));
};

export default function ErrorBanner() {
  const [error, setError] = useState(null);

  useEffect(() => {
    const handler = (msg) => setError(msg);
    listeners.push(handler);
    return () => { listeners = listeners.filter(l => l !== handler); };
  }, []);

  if (!error) return null;

  return (
    <TouchableOpacity style={styles.banner} onPress={() => setError(null)}>
      <Text style={styles.text} numberOfLines={3}>{error}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute', top: 0, left: 0, right: 0, zIndex: 9999,
    backgroundColor: '#B00020', paddingTop: 40, paddingBottom: 12, paddingHorizontal: 16,
  },
  text: { color: '#fff', fontWeight: '600' },
});
