// The nationwide prospecting grid the auto-scout loop walks. A monotonic cursor
// (stored in app_settings as auto_scout_cursor) is mapped onto metros x segments
// so coverage rotates across the whole country and wraps.

export const US_METROS=[
  'New York NY','Los Angeles CA','Chicago IL','Dallas TX','Houston TX',
  'Washington DC','Philadelphia PA','Miami FL','Atlanta GA','Boston MA',
  'Phoenix AZ','San Francisco CA','Riverside CA','Detroit MI','Seattle WA',
  'Minneapolis MN','San Diego CA','Tampa FL','Denver CO','Baltimore MD',
  'St. Louis MO','Orlando FL','Charlotte NC','San Antonio TX','Portland OR',
  'Sacramento CA','Pittsburgh PA','Austin TX','Las Vegas NV','Cincinnati OH',
  'Kansas City MO','Columbus OH','Indianapolis IN','Cleveland OH','San Jose CA',
  'Nashville TN','Virginia Beach VA','Providence RI','Milwaukee WI','Jacksonville FL',
  'Oklahoma City OK','Raleigh NC','Memphis TN','Richmond VA','Louisville KY',
  'New Orleans LA','Salt Lake City UT','Hartford CT','Buffalo NY','Birmingham AL',
  'Rochester NY','Grand Rapids MI','Tucson AZ','Honolulu HI','Tulsa OK',
  'Fresno CA','Worcester MA','Omaha NE','Greenville SC','Albuquerque NM',
  'Bakersfield CA','Knoxville TN','Albany NY','Baton Rouge LA','McAllen TX',
  'Columbia SC','Charleston SC','Stockton CA','Boise ID','Greensboro NC',
  'Little Rock AR','Des Moines IA','Spokane WA','Wichita KS','Madison WI',
  'Colorado Springs CO','Chattanooga TN','Fort Wayne IN','Lakeland FL','Dayton OH',
];

export const SEGMENTS=[
  'HVAC contractor','plumbing company','electrician','roofing company','landscaping and lawn care',
  'pest control','residential cleaning service','junk removal','moving company','pool service',
  'auto repair shop','auto body shop','towing company','tree service','fencing contractor',
  'painting contractor','flooring installer','garage door company','handyman service','pressure washing',
  'med spa','dental practice','chiropractor','physical therapy clinic','veterinary clinic',
  'optometry practice','home health agency','private practice therapist','bookkeeping and accounting firm','small law firm',
  'insurance agency','real estate brokerage','property management company','mortgage broker','staffing agency',
  'marketing agency','photography studio','event planning company','catering company','food truck operator',
  'gym and fitness studio','martial arts school','dance studio','salon and barbershop','tattoo studio',
  'print shop','sign company','screen printing shop','e-commerce brand','specialty retail shop',
  'solar installer','security system installer','locksmith','appliance repair','septic service',
];

// cursor -> which cell of the grid to work this cycle
export function pickTarget(cursor=0){
  const c=Math.abs(Math.floor(cursor))||0;
  const total=US_METROS.length*SEGMENTS.length;
  const i=c%total;
  const metro=US_METROS[i%US_METROS.length];
  const segment=SEGMENTS[Math.floor(i/US_METROS.length)%SEGMENTS.length];
  return{metro,segment,index:i,total};
}

// Rotating inbound-scan phrases so the loop doesn't hit the same query every cycle.
export const INBOUND_QUERIES=[
  'looking for someone to build a custom tool for my business',
  'is there software that can automate this for a small business',
  'need help automating repetitive work in my company',
  'want a custom app built for my business operations',
  'small business owner drowning in manual admin work',
  'how do I stop doing this task manually every day',
];
export function pickInboundQuery(cursor=0){
  return INBOUND_QUERIES[Math.abs(Math.floor(cursor))%INBOUND_QUERIES.length];
}
