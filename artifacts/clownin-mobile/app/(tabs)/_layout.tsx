// Unused — app uses (app)/ and (auth)/ groups instead of tabs
import { Redirect } from 'expo-router';
export default function TabsLayout() {
  return <Redirect href="/(app)" />;
}
