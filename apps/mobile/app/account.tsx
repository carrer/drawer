import Constants from 'expo-constants';
import { Stack } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteLocalFiles } from '@/capture';
import {
  getAccount,
  normalizeServerUrl,
  signInWithCode,
  signInWithGoogle,
  signOut,
  type Account as SignedIn,
} from '@/data/server';
import { useStoreDb, useWrite } from '@/data/store';
import { countUnsynced, wipeLocalData } from '@/db/repo';
import { font, useTheme, type Theme } from '@/theme';

/** Shown in `make devices`, so the operator can tell phones apart. */
const deviceName = () => Constants.deviceName ?? `${Platform.OS === 'ios' ? 'iPhone' : 'Android'} phone`;

/**
 * Sign in to a drawer (Google, or an operator's enrollment code), see which
 * account this phone is, and sign out. One account per install: signing out
 * wipes what this phone holds, so the next account starts clean.
 */
export default function AccountScreen() {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const [account, setAccount] = useState<SignedIn | null | undefined>(undefined);

  const load = useCallback(() => {
    getAccount()
      .then(setAccount)
      .catch((err) => {
        setAccount(null);
        Alert.alert('Can’t read this phone’s sign-in', err instanceof Error ? err.message : String(err));
      });
  }, []);
  useEffect(load, [load]);

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 40 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Account',
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.text,
          headerTitleStyle: { fontFamily: font.heading900, fontSize: 20, color: t.text },
          headerShadowVisible: false,
        }}
      />
      {account === undefined ? (
        <ActivityIndicator color={t.text} style={s.loading} />
      ) : account ? (
        <SignedInView account={account} s={s} onSignedOut={() => setAccount(null)} />
      ) : (
        <SignInView s={s} onSignedIn={setAccount} />
      )}
    </ScrollView>
  );
}

type S = ReturnType<typeof styles>;

function SignInView({ s, onSignedIn }: { s: S; onSignedIn: (a: SignedIn) => void }) {
  const t = useTheme();
  const [address, setAddress] = useState(process.env.EXPO_PUBLIC_DRAWER_URL ?? '');
  const [code, setCode] = useState<string | null>(null); // null: the code field is hidden
  const [busy, setBusy] = useState<'google' | 'code' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (how: 'google' | 'code') => {
    setError(null);
    setBusy(how);
    try {
      const url = normalizeServerUrl(address);
      const account =
        how === 'google' ? await signInWithGoogle(url, deviceName()) : await signInWithCode(url, code ?? '', deviceName());
      if (account) onSignedIn(account);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Text style={s.lead}>
        Sign in to your drawer to keep what you save backed up and on all your devices. Everything works offline
        without it.
      </Text>

      <View style={s.field}>
        <Text style={s.label}>Your drawer’s address</Text>
        <TextInput
          value={address}
          onChangeText={setAddress}
          placeholder="drawer.your-tailnet.ts.net"
          placeholderTextColor={t.placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={s.input}
        />
        <Text style={s.hint}>Your phone needs to be on your tailnet to reach it.</Text>
      </View>

      <Pressable
        onPress={() => void attempt('google')}
        disabled={busy !== null || !address.trim()}
        accessibilityRole="button"
        style={({ pressed }) => [s.primary, (pressed || busy !== null || !address.trim()) && s.dim]}
      >
        {busy === 'google' ? <ActivityIndicator color={t.onPrimary} /> : null}
        <Text style={s.primaryText}>Sign in with Google</Text>
      </Pressable>

      {code === null ? (
        <Pressable onPress={() => setCode('')} accessibilityRole="button" style={s.linkButton}>
          <Text style={s.link}>Use an enrollment code instead</Text>
        </Pressable>
      ) : (
        <View style={s.field}>
          <Text style={s.label}>Enrollment code</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="XXXX-XXXX-XXXX-XXXX"
            placeholderTextColor={t.placeholder}
            autoCapitalize="characters"
            autoCorrect={false}
            style={s.input}
          />
          <Text style={s.hint}>Whoever runs the drawer makes one with: make enroll-code EMAIL=you@…</Text>
          <Pressable
            onPress={() => void attempt('code')}
            disabled={busy !== null || !code.trim() || !address.trim()}
            accessibilityRole="button"
            style={({ pressed }) => [s.secondary, (pressed || busy !== null || !code.trim() || !address.trim()) && s.dim]}
          >
            <Text style={s.secondaryText}>{busy === 'code' ? 'Signing in…' : 'Sign in with code'}</Text>
          </Pressable>
        </View>
      )}

      {error ? <Text style={s.error}>{error}</Text> : null}
    </>
  );
}

function SignedInView({ account, s, onSignedOut }: { account: SignedIn; s: S; onSignedOut: () => void }) {
  const db = useStoreDb();
  const write = useWrite();
  const [busy, setBusy] = useState(false);

  const doSignOut = async () => {
    setBusy(true);
    try {
      const { revoked } = await signOut();
      write((d) => wipeLocalData(d));
      deleteLocalFiles();
      onSignedOut();
      if (!revoked) {
        Alert.alert(
          'Signed out on this phone',
          'Your drawer couldn’t be reached, so this phone’s access is still valid there until it’s revoked (make devices, then make revoke).',
        );
      }
    } catch (err) {
      Alert.alert('Couldn’t sign out', err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const confirm = () => {
    const unsynced = countUnsynced(db);
    Alert.alert(
      'Sign out?',
      (unsynced > 0
        ? `${unsynced} ${unsynced === 1 ? 'change hasn’t' : 'changes haven’t'} reached your drawer yet and will be lost. `
        : '') + 'Everything saved on this phone is removed from it; what’s in your drawer stays there.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: () => void doSignOut() },
      ],
    );
  };

  return (
    <>
      <View style={s.card}>
        <Text style={s.label}>Signed in as</Text>
        <Text style={s.value}>{account.email ?? 'an account without an email'}</Text>
        <Text style={[s.label, s.spaced]}>Drawer</Text>
        <Text style={s.value}>{account.url}</Text>
      </View>
      <Pressable
        onPress={confirm}
        disabled={busy}
        accessibilityRole="button"
        style={({ pressed }) => [s.danger, (pressed || busy) && s.dim]}
      >
        <Text style={s.dangerText}>{busy ? 'Signing out…' : 'Sign out'}</Text>
      </Pressable>
    </>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    content: { paddingHorizontal: 20, paddingTop: 4, gap: 16 },
    loading: { marginTop: 40 },
    lead: { fontFamily: font.body400, fontSize: 16, lineHeight: 23, color: t.secondary },
    field: { gap: 8 },
    label: { fontFamily: font.heading800, fontSize: 13, color: t.muted, textTransform: 'uppercase', letterSpacing: 0.6 },
    input: {
      height: 52,
      backgroundColor: t.surface,
      borderColor: t.border,
      borderWidth: 1,
      borderRadius: 16,
      paddingHorizontal: 16,
      fontFamily: font.body400,
      fontSize: 16,
      color: t.text,
    },
    hint: { fontFamily: font.body400, fontSize: 13, color: t.muted, lineHeight: 19, paddingHorizontal: 4 },
    primary: {
      height: 56,
      borderRadius: 18,
      backgroundColor: t.primary,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
    },
    primaryText: { fontFamily: font.heading800, fontSize: 17, color: t.onPrimary },
    secondary: {
      height: 52,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: t.border,
      backgroundColor: t.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { fontFamily: font.heading800, fontSize: 16, color: t.text },
    linkButton: { alignSelf: 'center', paddingVertical: 6 },
    link: { fontFamily: font.body600, fontSize: 15, color: t.secondary, textDecorationLine: 'underline' },
    error: { fontFamily: font.body600, fontSize: 15, lineHeight: 21, color: t.danger },
    card: { backgroundColor: t.surface, borderRadius: 20, padding: 18, gap: 4 },
    value: { fontFamily: font.heading800, fontSize: 18, color: t.text },
    spaced: { marginTop: 12 },
    danger: {
      height: 56,
      borderRadius: 18,
      borderWidth: 1,
      borderColor: t.dangerBorder,
      backgroundColor: t.dangerBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    dangerText: { fontFamily: font.heading800, fontSize: 17, color: t.danger },
    dim: { opacity: 0.55 },
  });
