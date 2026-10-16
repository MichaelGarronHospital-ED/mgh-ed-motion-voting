// Stand-in for the Firebase app module when the rules tests load js/db.js:
// nothing here talks to a real project.
export function initializeApp() { return { name: "[rules-test]" }; }
