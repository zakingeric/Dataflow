function serviceEnabled(feature) {
  return (req, res, next) => {
    // temporary allow all (or connect DB later)
    return next();
  };
}

module.exports = {
  serviceEnabled
};
