import '@/polyfills';
import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * ShareIntentProvider has to wrap everything — the native module is reached
 * through the deep link that launches the app, so it must be mounted before any
 * screen renders or the first share of a cold start is lost.
 *
 * resetOnBackground keeps a share from being replayed when you switch away and
 * come back, which would otherwise duplicate the item.
 */
export default function RootLayout() {
  return (
    <ShareIntentProvider options={{ debug: __DEV__, resetOnBackground: true }}>
      <SafeAreaProvider>
        <StatusBar style="auto" />
        <Stack screenOptions={{ headerShown: false }} />
      </SafeAreaProvider>
    </ShareIntentProvider>
  );
}
