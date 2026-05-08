module.exports = function serviceEnabled(flag) {
  return (req, res, next) => {
    if (!process.env[flag.toUpperCase()]) {
      return res.status(503).json({
        success: false,
        message: 'Service disabled'
      });
    }
    next();
  };
};
