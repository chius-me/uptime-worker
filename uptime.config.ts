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
    { link: 'https://blog.chius.cc', label: 'Blog' },
    { link: 'mailto:contact@chius.cc', label: 'Email Me', highlight: true },
  ],
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
      name: 'GoToSocial',
      method: 'GET',
      target: 'https://social.chius.cc',
      tooltip: 'GoToSocial instance',
      statusPageLink: 'https://social.chius.cc',
      expectedCodes: [200],
      timeout: 10000,
    },
  ],
  // [Optional] Notification settings
  // notification: {
  //   webhook: { ... },
  //   timeZone: 'Asia/Shanghai',
  // },
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
