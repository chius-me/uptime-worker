// This is a simplified example config file for quickstart
// Some not frequently used features are omitted/commented out here
// For a full-featured example, please refer to `uptime.config.full.ts`

// Don't edit this line
import { MaintenanceConfig, PageConfig, WorkerConfig } from './types/config'

const pageConfig: PageConfig = {
  // Title for your status page
  title: "Chius's Status Page",
  // Links shown at the header of your status page, could set `highlight` to `true`
  links: [
    { link: 'https://github.com/chius-me/', label: 'GitHub' },
    { link: 'mailto:contact@chius.cc', label: 'Email Me', highlight: true },
  ],
  logo: '/logo.png',
}

const workerConfig: WorkerConfig = {
  // Define all your monitors here
  monitors: [
    {
      id: 'website',
      name: 'Website',
      method: 'GET',
      target: 'https://chius.cc',
      tooltip: 'Personal website',
      statusPageLink: 'https://chius.cc',
      expectedCodes: [200],
      timeout: 10000,
    },
    {
      id: 'blog',
      name: 'Blog',
      method: 'GET',
      target: 'https://blog.chius.cc',
      tooltip: 'Personal blog',
      statusPageLink: 'https://blog.chius.cc',
      expectedCodes: [200],
      timeout: 10000,
    },
    {
      id: 'social',
      name: 'Fediverse',
      method: 'GET',
      target: 'https://social.chius.cc',
      tooltip: 'GoToSocial instance',
      statusPageLink: 'https://social.chius.cc',
      expectedCodes: [200],
      timeout: 10000,
    },
    {
      id: 'homelab',
      name: 'HomeLab',
      method: 'GET',
      target: 'https://live.lan.chius.cc',
      tooltip: 'Proxmox, TrueNAS and so on',
      statusPageLink: 'https://live.lan.chius.cc',
      expectedCodes: [200],
      timeout: 10000,
    },
    {
      id: 'vps1',
      name: 'VPS in Qingdao',
      method: 'TCP_PING',
      // 通过 CF Secrets 传入环境变量 <VPS1_IP> 和 <VPS1_PORT>
      target: '<VPS1_IP>:<VPS1_PORT>',
      tooltip: 'From Aliyun',
      timeout: 5000,
    },
    {
      id: 'vps2',
      name: 'VPS in Tyoko',
      method: 'TCP_PING',
      // 通过 CF Secrets 传入环境变量 <VPS2_IP> 和 <VPS2_PORT>
      target: '<VPS2_IP>:<VPS2_PORT>',
      tooltip: 'From AWS',
      timeout: 5000,
    },
  ],
  // [Optional] Notification settings
  notification: {
    webhook: {
      // 通过 CF Secrets (环境变量) 获取 Token
      url: 'https://api.telegram.org/bot<TG_BOT_TOKEN>/sendMessage',
      method: 'POST',
      payloadType: 'json',
      payload: {
        // 通过 CF Secrets (环境变量) 获取 Chat ID
        chat_id: '<TG_CHAT_ID>',
        text: '$MSG',
      },
    },
    // 通知中使用的时区
    timeZone: 'Asia/Shanghai',
    // (可选) 宽限期：持续宕机 x 分钟后才会发送通知
    // gracePeriod: 5,
  },
}

// You can define multiple maintenances here
// During maintenance, an alert will be shown at status page
// Also, related downtime notifications will be skipped (if any)
// Of course, you can leave it empty if you don't need this feature

// const maintenances: MaintenanceConfig[] = []

const maintenances: MaintenanceConfig[] = [
  // {
  //   monitors: ['blog', 'social'],
  //   title: 'Scheduled Maintenance',
  //   body: 'Server upgrade',
  //   start: '2026-01-01T00:00:00+08:00',
  //   end: '2026-01-01T02:00:00+08:00',
  // },
]

// Don't edit this line
export { maintenances, pageConfig, workerConfig }
