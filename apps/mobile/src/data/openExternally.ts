import { File } from 'expo-file-system';
import { Linking, Platform } from 'react-native';

const FLAG_GRANT_READ_URI_PERMISSION = 1;

/**
 * Hand a stored original to whatever app the OS picks for its type — a PDF
 * viewer, the video player. Drawer doesn't render these itself in v1.
 *
 * Android won't open our file:// paths from another app, so it gets a
 * content:// URI from our FileProvider plus a one-off read grant.
 *
 * expo-intent-launcher is loaded on first use, not imported at the top: a
 * static import of a native module that the installed dev client wasn't built
 * with throws while the route tree loads, taking the whole app down with it.
 * Lazily, the failure stays on this one button.
 */
export async function openFile(localPath: string, mimeType: string | null): Promise<void> {
  if (Platform.OS !== 'android') {
    await Linking.openURL(localPath);
    return;
  }
  let launcher: typeof import('expo-intent-launcher');
  try {
    launcher = await import('expo-intent-launcher');
  } catch {
    throw new Error('This build is missing expo-intent-launcher. Rebuild the dev client (make android).');
  }
  await launcher.startActivityAsync('android.intent.action.VIEW', {
    data: new File(localPath).contentUri,
    type: mimeType ?? '*/*',
    flags: FLAG_GRANT_READ_URI_PERMISSION,
  });
}
