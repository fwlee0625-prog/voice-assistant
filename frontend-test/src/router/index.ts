import { createRouter, createWebHistory } from 'vue-router'

import RecordView from '@/views/RecordView.vue'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    { path: '/', redirect: '/record' },
    {
      path: '/record',
      name: 'record',
      component: RecordView,
      meta: { title: '语音对话' },
    },
    { path: '/:pathMatch(.*)*', redirect: '/record' },
  ],
})

router.afterEach((to) => {
  const title = to.meta.title
  document.title = title ? `${title} · Billiards Voice` : 'Billiards Voice'
})

export default router
