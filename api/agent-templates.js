// AJOCREDIT Agent Module - message templates.
//
// Every template here is the exact approved wording from the agent brief.
// They are seeded into the database (message_templates) so an admin can edit
// them later, and the API serves them to the agent screens so the words on
// screen and the words sent on WhatsApp can never drift apart.
//
// Placeholders are written as [NAME] and are replaced when the message is
// filled in.

// ------------------------------------------- Section 7: admin messages ------
const WHATSAPP = {
  A_PENDING: {
    id: 'A_PENDING',
    channel: 'whatsapp',
    title: 'Pending - Corporate Application',
    body: `Hello [CONTACT PERSON NAME], 👋

Thank you for applying to become a Corporate Agent for AJOCREDIT by ZENONMAG CONCEPTS VENTSURES.

We received your application for [ORGANIZATION NAME].
Application ID: [ZEN-CORP-XXXX]
Status: Pending Verification

Our team will call you within 24 hours on [PHONE] to verify your organization.

Please keep your CAC certificate ready.

— AJOCREDIT Team
ZENONMAG CONCEPTS VENTSURES
Plot 79, Apo Resettlement Zone A, Abuja
+234 907 3892 436 | ajocredit.app@gmail.com`,
  },

  B_APPROVED: {
    id: 'B_APPROVED',
    channel: 'whatsapp',
    title: 'Approved - Corporate Agent Welcome',
    body: `Congratulations! 🎉

[ORGANIZATION NAME] is now an APPROVED Corporate Agent of AJOCREDIT by ZENONMAG CONCEPTS VENTSURES.

Your Corporate Agent Code: [ZEN-CORP-XXXX]
Your Agent Link: ajocredit.app/join/[ZEN-CORP-XXXX]
Contact Person: [CONTACT PERSON NAME]

What you can do now:
✅ Migrate your existing Ajo/Esusu groups to AJOCREDIT
✅ Create new groups for your members
✅ Add Sub-Agents under you
✅ Earn ₦500 per active member + 1% of first contribution

Login to your dashboard here 👇
ajocredit.pages.dev/agent-dashboard

Remember our Code: Never collect cash. All contributions are in the app only.

Welcome to the family!
— AJOCREDIT Team
ZENONMAG CONCEPTS VENTSURES`,
  },

  C_NEED_INFO: {
    id: 'C_NEED_INFO',
    channel: 'whatsapp',
    title: 'Need More Info',
    body: `Hello [CONTACT PERSON NAME],

Thank you for applying for Corporate Agent for AJOCREDIT by ZENONMAG CONCEPTS VENTSURES — [ORGANIZATION NAME].

We need a little more to verify you:
❗ [REASON — e.g. CAC certificate photo is blurry / Director ID missing / RC Number does not match]

Please resend the correct document on WhatsApp to this number, or upload again here:
ajocredit.pages.dev/agent-dashboard

Once we receive it, we will approve you within 24 hours.

— AJOCREDIT Team
ZENONMAG CONCEPTS VENTSURES
+234 907 3892 436`,
  },

  D_REJECTED: {
    id: 'D_REJECTED',
    channel: 'whatsapp',
    title: 'Rejected',
    body: `Hello [CONTACT PERSON NAME],

Thank you for your interest in becoming a Corporate Agent for AJOCREDIT by ZENONMAG CONCEPTS VENTSURES.

After review, we are unable to approve your application for [ORGANIZATION NAME] at this time.

Reason: [REASON — e.g. Documents could not be verified / Organization details do not match CAC records]

You can re-apply after 30 days with correct documents here:
ajocredit.pages.dev/become-agent

If you think this is a mistake, reply to this WhatsApp and our team will review again.

Thank you for understanding.
— AJOCREDIT Team
ZENONMAG CONCEPTS VENTSURES
ajocredit.app@gmail.com | +234 907 3892 436`,
  },

  E_SUSPENDED: {
    id: 'E_SUSPENDED',
    channel: 'whatsapp',
    title: 'Suspended',
    body: `Hello [AGENT NAME],

This is an official notice from AJOCREDIT by ZENONMAG CONCEPTS VENTSURES.

Your Agent Code [ZEN-AG-XXXX / ZEN-CORP-XXXX] has been SUSPENDED for breaking the Agent Code of Conduct.

Reason: [REASON — e.g. Collecting cash from members]

Your link is now inactive and unpaid commission is on hold pending review.

To appeal, reply to this WhatsApp within 7 days.

— AJOCREDIT Compliance Team
ZENONMAG CONCEPTS VENTSURES`,
  },
};

// --------------------------------------- Section 6: the agent's own flyers ----
const FLYERS = {
  A_MIGRATE: {
    id: 'A_MIGRATE',
    channel: 'flyer',
    title: 'For Existing Group - Migrate Group',
    body: `Hello my people! 👋

Na me, [AGENT NAME] — your AJOCREDIT Agent.

Our Ajo group don go digital! No more paper wahala, no more missing money.

With AJOCREDIT by ZENONMAG CONCEPTS VENTSURES, we go:
✅ Save together for Ajo
✅ Contribute for our phone inside app
✅ Collect for turn, on time
✅ Build credit score wey go help us collect loan later

Make we move our group — [GROUP NAME] — to AJOCREDIT today.

Join here 👇
🔗 ajocredit.app/join/[AGENT CODE]
My Agent Code: [ZEN-AG-XXXX]

If you need help, WhatsApp me: [AGENT WHATSAPP]

AJOCREDIT — Turn your Ajo into bank credit. Save with your people, build a real financial identity.
A product of ZENONMAG CONCEPTS VENTSURES.
📍 Plot 79, Apo Resettlement Zone A, Abuja | +234 907 3892 436`,
  },

  B_SHORT: {
    id: 'B_SHORT',
    channel: 'flyer',
    title: 'For New Person - Short Status',
    body: `Tired of Ajo wahala? 😩

Join AJOCREDIT — your Ajo, now on your phone.
Save with your people, collect for turn, build credit score.

Join with my link 👇
ajocredit.app/join/[AGENT CODE]
Agent: [AGENT NAME] | Code: [ZEN-AG-XXXX]

AJOCREDIT by ZENONMAG CONCEPTS VENTSURES`,
  },

  C_COOPERATIVE: {
    id: 'C_COOPERATIVE',
    channel: 'flyer',
    title: 'For Cooperative / Association Leader',
    body: `Good day Sir/Ma,

I am [AGENT NAME], an Agent of AJOCREDIT by ZENONMAG CONCEPTS VENTSURES.

We help cooperatives, market associations, churches and groups move their existing Ajo/Esusu groups to a safe digital platform.

Your members can:
- Contribute securely in the app
- Track who has collected and whose turn is next
- Build a credit history for future loans

We would like to onboard [COOPERATIVE NAME] to AJOCREDIT at no joining cost.

Let's talk: [AGENT WHATSAPP]
Or join: ajocredit.app/join/[AGENT CODE]

AJOCREDIT — A digital product of ZENONMAG CONCEPTS VENTSURES
Plot 79, Apo Resettlement Zone A, Abuja | ajocredit.app@gmail.com | +234 907 3892 436`,
  },
};

// The SMS an agent sends when they invite a member by phone.
const SMS = {
  A_INVITE: {
    id: 'A_INVITE',
    channel: 'sms',
    title: 'Invitation',
    body: "[AJOCREDIT] Join [ORGANIZATION NAME]'s Ajo group on AJOCREDIT. Save together, build credit. Your invite code: [CODE]. Register: [LINK]",
  },
};

// The recruiter's own scripts, so an agent knows exactly what to say.
const RECRUIT_SCRIPTS = {
  BIG_GROUP: {
    id: 'BIG_GROUP',
    title: 'Big Group (20+ members) - Church, Mosque, Cooperative, Association',
    body: `Group Leader WhatsApp message:

"Hello [LEADER NAME], I hope you're well. I'm [AGENT NAME], working with AJOCREDIT - a platform that helps Ajo groups track contributions and build credit. Your members can join our [ORGANIZATION NAME] Ajo group by registering at [LINK] and entering invite code [CODE]. There's no cost to members, and it gives them a payment record banks can see. Would you like me to show you how it works?"`,
    followUp: `Follow-up (if no reply after 3 days):

"Hi [LEADER NAME], just following up on the AJOCREDIT invite for your members. Here's the link: [LINK] and the code: [CODE]. Happy to demo it in 5 minutes at [MARKET/BUSINESS NAME] if that's easier."`,
  },

  MARKET_LEADER: {
    id: 'MARKET_LEADER',
    title: 'Market Leader / Individual (5-20 members)',
    body: `Personal WhatsApp:

"Hi [NAME], I found a way to make our Ajo contributions count for something more. With AJOCREDIT, we all register once with our phone numbers, and the group tracks who has paid - plus we each build a credit score banks take seriously. You just share your code [CODE] with the group, they register at [LINK]. Want me to set it up for us?"`,
  },

  INDIVIDUAL_MEMBER: {
    id: 'INDIVIDUAL_MEMBER',
    title: 'Individual Member (1-5 people)',
    body: `Casual message:

"Hey [NAME], quick one - the Ajo money we're contributing, we can start tracking it on our phones with AJOCREDIT. You register with your number, join with my code, and you see clearly who has paid what each month. No extra cost. Want the details?"`,
  },
};

const COMMISSION_EXPLAINER =
  'Every member you refer earns you ₦500 when they make their first contribution - and 1% of every contribution they make afterward, for 12 full months. For example: a member who contributes ₦5,000 every month for a year earns you ₦500 + ₦600 = ₦1,100 total.';

const ALL = [
  ...Object.values(WHATSAPP),
  ...Object.values(FLYERS),
  ...Object.values(SMS),
  ...Object.values(RECRUIT_SCRIPTS),
];

module.exports = { WHATSAPP, SMS, FLYERS, RECRUIT_SCRIPTS, COMMISSION_EXPLAINER, ALL };
