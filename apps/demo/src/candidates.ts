export interface Candidate {
  name: string;
  role: string;
  company: string;
  yearsExperience: number;
  skills: string[];
  location: string;
}

export const candidates: Candidate[] = [
  {
    name: "Maya Lindqvist",
    role: "Senior Backend Engineer",
    company: "Fjordware",
    yearsExperience: 8,
    skills: ["Go", "Postgres", "Kubernetes"],
    location: "Stockholm, SE",
  },
  {
    name: "Tomás Ferreira",
    role: "Staff Frontend Engineer",
    company: "Azulejo Systems",
    yearsExperience: 10,
    skills: ["TypeScript", "React", "Design Systems"],
    location: "Lisbon, PT",
  },
  {
    name: "Priya Raghavan",
    role: "ML Engineer",
    company: "Quanta Retail",
    yearsExperience: 5,
    skills: ["Python", "PyTorch", "Recommendation Systems"],
    location: "London, UK",
  },
  {
    name: "Jonas Weber",
    role: "Platform Engineer",
    company: "Bergbahn Tech",
    yearsExperience: 7,
    skills: ["Terraform", "AWS", "Observability"],
    location: "Munich, DE",
  },
  {
    name: "Aisling O'Connor",
    role: "Full-Stack Engineer",
    company: "Cliffside Digital",
    yearsExperience: 4,
    skills: ["Node.js", "React", "MongoDB"],
    location: "Dublin, IE",
  },
  {
    name: "Karim El-Sayed",
    role: "Data Engineer",
    company: "Deltaflow Analytics",
    yearsExperience: 6,
    skills: ["Spark", "Airflow", "dbt"],
    location: "Amsterdam, NL",
  },
  {
    name: "Elena Petrova",
    role: "Senior Mobile Engineer",
    company: "Lumen Apps",
    yearsExperience: 9,
    skills: ["Swift", "Kotlin", "GraphQL"],
    location: "Berlin, DE",
  },
  {
    name: "Marco Bianchi",
    role: "DevOps Engineer",
    company: "Vetro Cloud",
    yearsExperience: 5,
    skills: ["Docker", "CI/CD", "Python"],
    location: "Milan, IT",
  },
];
