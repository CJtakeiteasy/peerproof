process.on("message", () => {
  // Deliberately never responds; parent timeout must terminate this worker.
});
