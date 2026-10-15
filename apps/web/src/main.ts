import { createApp } from 'vue';
import { createPinia } from 'pinia';
import Vant from 'vant';
import 'vant/lib/index.css';
import './styles/tokens.css';
import './styles/base.css';
import App from './App.vue';
import { router } from './router';

// 骨架阶段全量注册 Vant，后续可换成按需引入以减小体积（M2 优化项）。
createApp(App).use(createPinia()).use(router).use(Vant).mount('#app');
