import type { Priority } from "./model";

/**
 * Quick-start templates for the compose form. Every text field has variants;
 * "re-roll" on the website picks a different one.
 */
export interface Template {
  id: string;
  emoji: string;
  name: string;
  classification: string[];
  title: string[];
  objective: string[];
  location: string[];
  durationMin: number;
  priority: Priority;
  dressCode: string[];
  signatureTitle: string[];
}

export const TEMPLATES: Template[] = [
  {
    id: "gaming",
    emoji: "🎮",
    name: "Gaming",
    classification: ["COMBAT READINESS ORDER", "COMPETITIVE DEPLOYMENT NOTICE", "SUMMONER'S RIFT MOBILIZATION ORDER"],
    title: ["League of Legends Competitive Deployment", "Operation Elo Recovery", "Five-Stack Assembly Directive"],
    objective: [
      "The team is critically understaffed. Your presence on the Rift is required to restore morale and secure LP.",
      "Intelligence reports indicate the enemy jungler is unsupervised. Immediate reinforcement is requested.",
      "Mission parameters: queue up, do not tilt, and refrain from flaming the support. Snacks are the responsibility of each operative.",
    ],
    location: ["Summoner's Rift (Discord voice)", "Voice channel, sector #general", "The Rift. You know where."],
    durationMin: 180,
    priority: "high",
    dressCode: ["Headset mandatory", "Gaming chair, upright posture", "Comfort-grade hoodie"],
    signatureTitle: ["Supreme Commander of the Bot Lane", "Chief Strategy Officer (Hardstuck Gold)", "Shotcaller-in-Chief"],
  },
  {
    id: "groceries",
    emoji: "🛒",
    name: "Groceries",
    classification: ["MANDATORY LOGISTICS OPERATION", "SUPPLY CHAIN DIRECTIVE", "PROVISIONS ACQUISITION ORDER"],
    title: ["Procurement Run — LIDL", "Operation Middle Aisle", "Strategic Snack Reserve Replenishment"],
    objective: [
      "Procurement of Pepsi, chips and questionable bakery items.",
      "Acquire essential provisions. Secondary objective: investigate the middle aisle for power tools nobody needs.",
      "The strategic snack reserve has reached critically low levels. A coordinated resupply is required.",
    ],
    location: ["Lidl", "The nearest Lidl", "Lidl (the big one)"],
    durationMin: 45,
    priority: "elevated",
    dressCode: ["Civilian attire", "Comfortable shoes for aisle navigation", "Reusable bag mandatory"],
    signatureTitle: ["Chief Logistics Officer", "Director of Snack Acquisition", "Head of Procurement"],
  },
  {
    id: "food",
    emoji: "🍕",
    name: "Food",
    classification: ["EMERGENCY NUTRITION SUMMIT", "CALORIC DEFICIT RESPONSE ORDER", "CULINARY INTELLIGENCE BRIEFING"],
    title: ["Emergency Nutrition Summit", "Operation Full Stomach", "Joint Task Force: Fries"],
    objective: [
      "A critical caloric deficit has been detected. Attendance at the summit is required to resolve the situation.",
      "Delegates will convene to evaluate local food options and select one after an unreasonable amount of debate.",
      "Mandatory consumption of food in a group setting. Splitting the bill will be negotiated on site.",
    ],
    location: ["TBD (somewhere with fries)", "The usual place", "Wherever is open"],
    durationMin: 60,
    priority: "high",
    dressCode: ["Elastic waistband recommended", "Napkin-ready", "Business casual (hungry)"],
    signatureTitle: ["Minister of Snacks", "Chief Nutrition Officer", "Undersecretary of Fries"],
  },
  {
    id: "gym",
    emoji: "🏋️",
    name: "Gym",
    classification: ["PHYSICAL READINESS ASSESSMENT", "MANDATORY FITNESS DIRECTIVE", "STRENGTH COMPLIANCE AUDIT"],
    title: ["Physical Readiness Assessment", "Operation Leg Day", "Quarterly Gains Review"],
    objective: [
      "Personnel are required to report for a physical readiness assessment. Skipping leg day will be noted.",
      "Objective: lift heavy objects, put them down again, and look at ourselves in the mirror with confidence.",
      "A spotter is required. You have been identified as the most qualified candidate.",
    ],
    location: ["The gym", "Gym (ground floor, near the squat rack)", "The usual gym"],
    durationMin: 90,
    priority: "elevated",
    dressCode: ["Athletic wear", "Gym attire; no jeans", "Whatever you can sweat in"],
    signatureTitle: ["Director of Gains", "Chief Fitness Officer", "Head of Leg Day Enforcement"],
  },
  {
    id: "movie",
    emoji: "🎬",
    name: "Movie",
    classification: ["CINEMATIC INTELLIGENCE BRIEFING", "FILM SCREENING DIRECTIVE", "AUDIOVISUAL REVIEW BOARD"],
    title: ["Cinematic Intelligence Briefing", "Operation Popcorn", "Mandatory Film Screening"],
    objective: [
      "Attendance is required at a screening of classified audiovisual material. Commentary during the film is permitted but discouraged.",
      "The Board will review a feature-length film and argue about it afterwards.",
      "Popcorn will be procured. Seating will be allocated on a first come, first served basis.",
    ],
    location: ["Cinema", "Living room (projector deployed)", "Discord stream"],
    durationMin: 150,
    priority: "routine",
    dressCode: ["Pajamas acceptable", "Hoodie recommended", "Smart casual"],
    signatureTitle: ["Chief Screening Officer", "Director of Popcorn Logistics", "Head of the Review Board"],
  },
  {
    id: "coffee",
    emoji: "☕",
    name: "Coffee",
    classification: ["CAFFEINE SUPPLY CHAIN REVIEW", "MORNING READINESS DIRECTIVE", "STIMULANT INTAKE CONFERENCE"],
    title: ["Caffeine Supply Chain Review", "Operation Espresso", "Bilateral Coffee Talks"],
    objective: [
      "Caffeine levels across the department have fallen below operational thresholds. A review is required.",
      "Delegates will convene over coffee to discuss everything except work.",
      "A short, high-level meeting over hot beverages. Gossip is on the agenda.",
    ],
    location: ["The coffee place", "Starbucks", "Café around the corner"],
    durationMin: 45,
    priority: "routine",
    dressCode: ["Business casual", "Sunglasses optional", "Whatever is clean"],
    signatureTitle: ["Chief Caffeine Officer", "Director of Beverage Affairs", "Head Barista Liaison"],
  },
  {
    id: "drinks",
    emoji: "🍻",
    name: "Drinks",
    classification: ["POST-OPERATIONAL DEBRIEF", "MORALE RESTORATION ORDER", "SOCIAL HYDRATION INITIATIVE"],
    title: ["Post-Operational Debrief", "Operation Cheers", "Mandatory Morale Restoration Event"],
    objective: [
      "Following a demanding week, all personnel are ordered to attend a debrief over drinks.",
      "Morale has been assessed as low. Mandatory restoration measures are being enacted.",
      "Attendance is compulsory. Leaving early requires written justification.",
    ],
    location: ["The usual bar", "TBD (somewhere with seats)", "Rooftop, weather permitting"],
    durationMin: 180,
    priority: "high",
    dressCode: ["Going-out attire", "Smart casual", "No sweatpants (seriously)"],
    signatureTitle: ["Minister of Morale", "Chief Hydration Officer", "Director of Social Affairs"],
  },
  {
    id: "walk",
    emoji: "🚶",
    name: "Walk",
    classification: ["PERIMETER PATROL ASSIGNMENT", "OUTDOOR RECONNAISSANCE ORDER", "FRESH AIR COMPLIANCE NOTICE"],
    title: ["Perimeter Patrol", "Operation Touch Grass", "Neighborhood Reconnaissance"],
    objective: [
      "Personnel are assigned to patrol the perimeter on foot. Grass will be touched.",
      "Vitamin D levels are critically low. Mandatory outdoor exposure has been scheduled.",
      "Reconnaissance of the local area. Ice cream stops are authorized.",
    ],
    location: ["The park", "Meet outside my place", "Riverside"],
    durationMin: 60,
    priority: "routine",
    dressCode: ["Comfortable shoes", "Weather-appropriate attire", "Sunscreen recommended"],
    signatureTitle: ["Chief Patrol Officer", "Director of Outdoor Affairs", "Head of Grass-Touching"],
  },
];

export const BLANK_TEMPLATE: Template = {
  id: "custom",
  emoji: "📝",
  name: "Custom",
  classification: ["OFFICIAL SUMMONS"],
  title: [""],
  objective: [""],
  location: [""],
  durationMin: 60,
  priority: "routine",
  dressCode: [""],
  signatureTitle: ["Issuing Officer"],
};

export const ALL_TEMPLATES: Template[] = [...TEMPLATES, BLANK_TEMPLATE];
