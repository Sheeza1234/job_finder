// Shapes of the server's JSON. Deep, rarely-read structures (AI analysis, CV models) stay loose on purpose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

export interface Market { code: 'SA' | 'PK'; country: string; cities: string[] }
export interface Meta { categories: string[]; cities: string[]; markets: Market[]; statuses: [string, string][] }
export interface Provider { id: string; enabled: boolean }
export interface AppStatus { mode: 'demo' | 'production'; ai: boolean; ai_target?: { name: string }; providers: Provider[] }

export interface Experience { id: string; title: string; company: string; location: string; start: string; end: string; current: boolean; bullets: string[] }
export interface Education { id: string; degree: string; institution: string; year: string; notes: string }
export interface Certification { id: string; name: string; issuer: string; year: string }
export interface Project { id: string; name: string; description: string; url: string; tech: string[] }
export interface Answers { salaryExpectation: string; noticePeriod: string; expectedStartDate: string; workAuthorization: string; visaStatus: string; relocation: string }
export interface ProfilePrefs { cities: string[]; employmentTypes: string[]; workModes: string[]; needsSponsorship: boolean; openToRelocation: boolean }
export interface Profile {
  fullName: string; email: string; phone: string; location: string; headline: string; yearsExperience: number | string;
  linkedinUrl: string; websiteUrl: string; portfolioUrl: string; summary: string;
  skills: string[]; languages: string[]; achievements: string[]; categories: string[]; preferredTitles: string[]; cvKeywords?: string[];
  experience: Experience[]; education: Education[]; certifications: Certification[]; projects: Project[];
  answers: Answers; preferences: ProfilePrefs;
}

export interface Job {
  id: number; title: string; company?: string; city?: string; location_text?: string; source?: string; url?: string; description?: string;
  work_mode: string; employment_type: string; experience_level: string; sponsorship: string; relocation: string; remote_eligibility?: string;
  salary_min?: number; salary_max?: number; salary_currency?: string; posted_at?: string; match_score: number | null; match_method?: string; app_status?: string;
}
export interface CvVersionRow { id: number; version_no: number; status: string; origin: string; warnings: number; approved_at?: string; job_id?: number }
export interface LetterRow { id: number; version_no: number; status: string; language: string; warnings: number }
export interface Application extends Rec { status: string; cv_version_id?: number; letter_version_id?: number; cv_version?: Rec; letter_version?: Rec }
export interface JobDetailData { job: Job; analysis: Rec | null; application: Application | null; heuristic: Rec; cv_versions: CvVersionRow[]; letters: LetterRow[] }
export interface DocRow { id: number; kind: string; filename: string; text_chars: number; created_at: string; is_master?: boolean }
