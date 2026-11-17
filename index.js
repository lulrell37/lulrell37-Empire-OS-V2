import './src/matchAllFix'; // first: replaces Hermes's String.prototype.matchAll (see the file)
import { registerRootComponent } from 'expo';
import App from './App';
registerRootComponent(App);
