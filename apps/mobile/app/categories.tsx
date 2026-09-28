import { INBOX_CATEGORY_ID } from '@drawer/shared';
import { Stack } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCategories, useWrite } from '@/data/store';
import { createCategory, deleteCategory, moveCategory, updateCategory, type LocalCategory } from '@/db/repo';
import { seedSampleData } from '@/db/seed';
import { CATEGORY_HUES, categoryHue, font, useTheme, type Theme } from '@/theme';

export default function Categories() {
  const t = useTheme();
  const s = styles(t);
  const insets = useSafeAreaInsets();
  const write = useWrite();
  const categories = useCategories();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  /** Runs a write and turns a broken rule (duplicate name, Inbox) into an alert. */
  const attempt = (fn: Parameters<typeof write>[0]): boolean => {
    try {
      write(fn);
      return true;
    } catch (err) {
      Alert.alert('Can’t do that', err instanceof Error ? err.message : String(err));
      return false;
    }
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    if (attempt((db) => createCategory(db, { name }))) setNewName('');
  };

  const confirmDelete = (c: LocalCategory) =>
    Alert.alert(
      `Delete “${c.name}”?`,
      c.itemCount > 0
        ? `Its ${c.itemCount} ${c.itemCount === 1 ? 'item stays' : 'items stay'} in your drawer, just no longer filed here.`
        : 'It has no items.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => attempt((db) => deleteCategory(db, c.id)) },
      ],
    );

  return (
    <ScrollView
      style={s.screen}
      contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 40 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Stack.Screen
        options={{
          headerShown: true,
          title: 'Categories',
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.text,
          headerTitleStyle: { fontFamily: font.heading900, fontSize: 20, color: t.text },
          headerShadowVisible: false,
        }}
      />

      {categories.map((c, i) => (
        <Row
          key={c.id}
          c={c}
          index={i}
          s={s}
          last={i === categories.length - 1}
          expanded={expanded === c.id}
          onToggle={() => setExpanded(expanded === c.id ? null : c.id)}
          onRename={(name) => attempt((db) => updateCategory(db, c.id, { name }))}
          onColor={(color) => attempt((db) => updateCategory(db, c.id, { color }))}
          onMove={(dir) => attempt((db) => moveCategory(db, c.id, dir))}
          onDelete={() => confirmDelete(c)}
        />
      ))}

      <View style={s.addRow}>
        <TextInput
          value={newName}
          onChangeText={setNewName}
          onSubmitEditing={add}
          placeholder="New category"
          placeholderTextColor={t.placeholder}
          returnKeyType="done"
          maxLength={64}
          style={s.addInput}
        />
        <Pressable
          onPress={add}
          disabled={!newName.trim()}
          style={({ pressed }) => [s.addButton, (!newName.trim() || pressed) && { opacity: 0.5 }]}
          accessibilityRole="button"
        >
          <Text style={s.addButtonText}>Add</Text>
        </Pressable>
      </View>

      <Text style={s.hint}>Tap a category’s colour for options. Inbox can be renamed but not deleted.</Text>

      {__DEV__ ? (
        <View style={s.dev}>
          <Text style={s.devLabel}>Development</Text>
          <Pressable
            onPress={() => {
              const added = write(seedSampleData);
              Alert.alert('Sample data', added > 0 ? `Added ${added} items.` : 'Already loaded.');
            }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={s.devAction}>Load sample data</Text>
          </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
}

function Row({
  c,
  index,
  s,
  last,
  expanded,
  onToggle,
  onRename,
  onColor,
  onMove,
  onDelete,
}: {
  c: LocalCategory;
  index: number;
  s: Styles;
  last: boolean;
  expanded: boolean;
  onToggle: () => void;
  onRename: (name: string) => boolean;
  onColor: (color: string | null) => boolean;
  onMove: (dir: -1 | 1) => boolean;
  onDelete: () => void;
}) {
  const t = useTheme();
  const hue = categoryHue(t, c.color, index);
  const [name, setName] = useState(c.name);
  useEffect(() => setName(c.name), [c.name]);

  const saveName = () => {
    const trimmed = name.trim();
    if (!trimmed) return setName(c.name); // an empty name isn't a rename
    if (trimmed !== c.name && !onRename(trimmed)) setName(c.name);
  };

  return (
    <View style={s.card}>
      <View style={s.rowMain}>
        <Pressable
          onPress={onToggle}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          accessibilityLabel={`${c.name} options`}
        >
          <View style={[s.stripe, { backgroundColor: hue.bar }]} />
        </Pressable>
        <TextInput
          value={name}
          onChangeText={setName}
          onEndEditing={saveName}
          maxLength={64}
          style={s.nameInput}
          accessibilityLabel={`${c.name} name`}
        />
        <Text style={s.count}>{c.itemCount}</Text>
        <Pressable
          onPress={onToggle}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`${c.name} options`}
        >
          <View style={[s.handle, { backgroundColor: expanded ? hue.bar : t.border }]} />
        </Pressable>
      </View>

      {expanded ? (
        <View style={[s.options, { backgroundColor: hue.panel }]}>
          <View style={s.swatches}>
            {CATEGORY_HUES.map((h) => {
              const color = t.hues[h].bar;
              const selected = c.color?.toLowerCase() === color.toLowerCase();
              return (
                <Pressable
                  key={h}
                  onPress={() => onColor(selected ? null : color)}
                  hitSlop={4}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${h} colour`}
                  style={[s.swatch, { backgroundColor: color }, selected && { borderColor: t.text }]}
                />
              );
            })}
          </View>
          <View style={s.optionButtons}>
            <Small s={s} label="Move up" disabled={index === 0} onPress={() => onMove(-1)} />
            <Small s={s} label="Move down" disabled={last} onPress={() => onMove(1)} />
            <View style={{ flex: 1 }} />
            {c.id !== INBOX_CATEGORY_ID ? <Small s={s} label="Delete" danger onPress={onDelete} /> : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Small({
  s,
  label,
  onPress,
  disabled,
  danger,
}: {
  s: Styles;
  label: string;
  onPress: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      style={({ pressed }) => [s.small, danger && s.smallDanger, (disabled || pressed) && { opacity: 0.4 }]}
    >
      <Text style={[s.smallText, danger && s.smallDangerText]}>{label}</Text>
    </Pressable>
  );
}

type Styles = ReturnType<typeof styles>;
const styles = (t: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: t.bg },
    content: { paddingHorizontal: 20, paddingTop: 4, gap: 14 },

    card: { backgroundColor: t.surface, borderRadius: 20, overflow: 'hidden' },
    rowMain: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 10, paddingHorizontal: 16 },
    stripe: { width: 6, height: 36, borderRadius: 3 },
    nameInput: { flex: 1, fontFamily: font.heading800, fontSize: 18, color: t.text, paddingVertical: 6 },
    count: { fontFamily: font.body600, fontSize: 13, color: t.muted },
    handle: { width: 40, height: 10, borderRadius: 5 },

    options: { marginHorizontal: 10, marginBottom: 10, borderRadius: 14, padding: 12, gap: 14 },
    swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
    swatch: { width: 32, height: 32, borderRadius: 10, borderWidth: 3, borderColor: 'transparent' },
    optionButtons: { flexDirection: 'row', gap: 8 },
    small: {
      height: 36,
      paddingHorizontal: 14,
      borderRadius: 12,
      justifyContent: 'center',
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: t.border,
    },
    smallText: { fontFamily: font.heading800, fontSize: 14, color: t.text },
    smallDanger: { backgroundColor: t.dangerBg, borderColor: t.dangerBorder },
    smallDangerText: { color: t.danger },

    addRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
    addInput: {
      flex: 1,
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
    addButton: { justifyContent: 'center', paddingHorizontal: 22, borderRadius: 16, backgroundColor: t.primary },
    addButtonText: { fontFamily: font.heading800, fontSize: 16, color: t.onPrimary },
    hint: { fontFamily: font.body400, fontSize: 13, color: t.muted, lineHeight: 19, paddingHorizontal: 4 },

    dev: { marginTop: 24, gap: 8, paddingHorizontal: 4 },
    devLabel: {
      fontFamily: font.heading800,
      fontSize: 13,
      letterSpacing: 0.8,
      textTransform: 'uppercase',
      color: t.muted,
    },
    devAction: { fontFamily: font.heading800, fontSize: 15, color: t.hues.blue.ink },
  });
