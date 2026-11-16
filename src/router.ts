import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView },
    // Room codes are the only other pages: /AB12CD34
    { path: '/:room', component: () => import('./views/RoomView.vue'), props: true },
  ],
  scrollBehavior: () => ({ top: 0 }),
})
