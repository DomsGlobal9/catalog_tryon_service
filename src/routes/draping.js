const express = require('express');
const router = express.Router();

const catalogRouter = require('./catalogRoutes');
const menRouter = require('./menRoutes');

// ============================================================
// CATEGORY-BASED DISPATCHER
// ============================================================
// The frontend will send category: "women" or "men"
// We dispatch to the appropriate underlying existing routes.

router.post('/generate-catalog', (req, res, next) => {
    const { category } = req.body;

    if (!category) {
        return res.status(400).json({ 
            success: false, 
            error: "Validation Error: 'category' field is required ('women' or 'men')." 
        });
    }

    if (category === 'women') {
        req.url = '/generate-catalog/women';
        // Restore existing API structure expecting garment type in `category` for women
        req.body.category = req.body.garmentCategory || 'SAREE';
        return next();
    } 
    
    if (category === 'men') {
        req.url = '/generate-catalog/men';
        // Restore garment type for men
        req.body.category = req.body.garmentCategory || 'FORMALS';
        return next();
    }

    return res.status(400).json({ 
        success: false, 
        error: "Validation Error: Invalid category. Must be 'women' or 'men'." 
    });
});

router.post('/cancel-job', (req, res, next) => {
    const { clientId } = req.body;
    
    // The frontends send specific clientIds
    if (clientId === 'frontend-test-suite') {
        req.url = '/cancel-job/women';
        return next();
    } 
    
    if (clientId === 'men-frontend') {
        req.url = '/cancel-job/men';
        return next();
    }

    // Fallback
    req.url = '/cancel-job/women';
    return next();
});

router.use(catalogRouter);
router.use(menRouter);

module.exports = router;
