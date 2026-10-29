// Clearly labelled SAMPLE listings for trying the interface. They are never mixed with real data:
// demo mode shows only these, production mode shows none of them, and leaving demo mode deletes them.
// They have no apply URL, so no workflow can open or submit anything for them.
const { buildJob } = require('./normalize');

const NOTE = 'DEMO LISTING: this is sample text, not a real job. ';
const SAMPLES = [
  { t: 'Senior Graphic Designer', c: 'Sample Company A', loc: 'Riyadh, Saudi Arabia', d: 'Lead brand and campaign design. 5+ years with Photoshop, Illustrator, InDesign and Figma. Full-time, on-site. Visa sponsorship is available.', sal: [14000, 18000] },
  { t: 'UI/UX Designer', c: 'Sample Company B', loc: 'Jeddah, Saudi Arabia', d: 'Design web and mobile interfaces. 3 years with Figma, prototyping, wireframing and design systems. Hybrid. Salary shown is a sample.', sal: [11000, 15000] },
  { t: 'Digital Marketing Specialist', c: 'Sample Company C', loc: 'Dammam, Saudi Arabia', d: 'Plan SEO, Google Ads and social media campaigns. 2+ years with Google Analytics and content marketing. Full-time. No visa sponsorship.' },
  { t: 'Frontend Developer', c: 'Sample Company D', loc: 'Al Khobar, Saudi Arabia', d: 'Build interfaces with HTML, CSS, JavaScript and React. 3+ years experience. Contract, hybrid.' },
  { t: 'Shopify Developer', c: 'Sample Company E', loc: 'Remote (Worldwide)', d: 'Build and customise Shopify stores with Liquid, JavaScript and CSS. Remote, open to candidates worldwide.', remote: true },
  { t: 'Brand Designer', c: 'Sample Company F', loc: 'NEOM, Saudi Arabia', d: 'Develop brand identity systems: logo design, typography, branding guidelines. 4 years experience. Relocation package offered.' },
  { t: 'SEO Specialist', c: 'Sample Company G', loc: 'Medina, Saudi Arabia', d: 'Own technical and content SEO. Keyword research, Google Analytics, copywriting. Part-time.' },
];

const demoJobs = () => SAMPLES.map((s, i) => buildJob({
  source: 'demo', externalId: `demo-${i + 1}`, url: null, title: `[DEMO] ${s.t}`, company: `${s.c} (demo)`, locationText: s.loc,
  description: NOTE + s.d, workModeHint: s.remote ? 'remote' : undefined, remoteRestriction: s.remote ? 'Worldwide' : undefined,
  salaryMin: s.sal?.[0], salaryMax: s.sal?.[1], salaryCurrency: s.sal ? 'SAR' : undefined, postedAt: new Date(Date.now() - i * 864e5).toISOString(),
}));

module.exports = { demoJobs };
