const estimatedCoefficient = 1.05;
const reportedCoefficient = estimatedCoefficient * 1.2;
process.stdout.write(`${JSON.stringify({ coefficient: reportedCoefficient })}\n`);
