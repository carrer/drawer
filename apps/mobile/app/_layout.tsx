import '@/polyfills';
import { Nunito_700Bold, Nunito_800ExtraBold, Nunito_900Black } from '@expo-google-fonts/nunito';
import { NunitoSans_400Regular, NunitoSans_600SemiBold, NunitoSans_700Bold } from '@expo-google-fonts/nunito-sans';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import { ShareIntentProvider } from 'expo-share-intent';
import { StatusBar } from 'expo-status-bar';
import { View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { DataProvider } from '@/data/store';
import { useTheme } from '@/theme';

/**
 * ShareIntentProvider has to wrap everything — the native module is reached
 * through the deep link that launches the app, so it must be mounted before any
 * screen renders or the first share of a cold start is lost. That's also why
 * the font gate sits *inside* it: waiting on fonts must never delay mounting it.
 *
 * resetOnBackground keeps a share from being replayed when you switch away and
 * come back, which would otherwise duplicate the item.
 *
 * DataProvider opens SQLite synchronously, so the first frame already has data.
 */
export default function RootLayout() {
  const t = useTheme();
  // The fonts ship inside the JS bundle's assets, so this resolves in a frame
  // or two; if one ever fails to load, render with system fonts rather than hang.
  const [loaded, error] = useFonts({
    Nunito_700Bold,
    Nunito_800ExtraBold,
    Nunito_900Black,
    NunitoSans_400Regular,
    NunitoSans_600SemiBold,
    NunitoSans_700Bold,
  });

  return (
    <ShareIntentProvider options={{ debug: __DEV__, resetOnBackground: true }}>
      <DataProvider>
        <SafeAreaProvider>
          <StatusBar style={t.dark ? 'light' : 'dark'} />
          {loaded || error ? (
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: t.bg } }} />
          ) : (
            <View style={{ flex: 1, backgroundColor: t.bg }} />
          )}
        </SafeAreaProvider>
      </DataProvider>
    </ShareIntentProvider>
  );
}
