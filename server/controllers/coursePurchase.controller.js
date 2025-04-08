import axios from "axios";
import { Course } from "../models/course.model.js";
import { CoursePurchase } from "../models/coursePurchase.model.js";
import { Lecture } from "../models/lecture.model.js";
import { User } from "../models/user.model.js";

const KONNECT_API_KEY = process.env.KONNECT_API_KEY;
const KONNECT_BASE_URL = process.env.KONNECT_BASE_URL || "https://api.konnect.network";
const KONNECT_RECEIVER_WALLET_ID = process.env.KONNECT_RECEIVER_WALLET_ID;

// Initialize Konnect payment
export const createCheckoutSession = async (req, res) => {
  try {
    const userId = req.id;
    const { courseId } = req.body;

    const course = await Course.findById(courseId);
    if (!course) return res.status(404).json({ message: "Course not found!" });

    // Create a new course purchase record
    const newPurchase = new CoursePurchase({
      courseId,
      userId,
      amount: course.coursePrice,
      status: "pending",
    });

    // Prepare Konnect payment request
    const paymentData = {
      receiverWalletId: KONNECT_RECEIVER_WALLET_ID,
      token: "TND", // Assuming transactions are in Tunisian Dinar
      amount: course.coursePrice * 1000, // Convert to millimes
      type: "immediate",
      description: `Payment for course: ${course.courseTitle}`,
      acceptedPaymentMethods: ["wallet", "bank_card", "e-DINAR"],
      lifespan: 30, // 30 minutes expiration
      checkoutForm: true,
      addPaymentFeesToAmount: false,
      orderId: newPurchase._id.toString(),
      webhook: `${process.env.BASE_URL}/api/payments/webhook`,
      silentWebhook: true,
      successUrl: `${process.env.FRONTEND_URL}/course-progress/${courseId}`,
      failUrl: `${process.env.FRONTEND_URL}/course-detail/${courseId}`,
      theme: "light"
    };

    // Get user details if available
    const user = await User.findById(userId);
    if (user) {
      paymentData.firstName = user.firstName || "";
      paymentData.lastName = user.lastName || "";
      paymentData.email = user.email || "";
      paymentData.phoneNumber = user.phoneNumber || "";
    }

    // Call Konnect API to initiate payment
    const response = await axios.post(
      `${KONNECT_BASE_URL}/payments/init-payment`,
      paymentData,
      {
        headers: {
          "x-api-key": KONNECT_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    if (!response.data.payUrl) {
      return res
        .status(400)
        .json({ success: false, message: "Error while creating payment session" });
    }

    // Save the purchase record with Konnect payment reference
    newPurchase.paymentId = response.data.paymentRef;
    await newPurchase.save();

    return res.status(200).json({
      success: true,
      url: response.data.payUrl, // Return the Konnect payment URL
    });
  } catch (error) {
    console.error("Error creating Konnect payment:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// Konnect webhook handler
export const konnectWebhook = async (req, res) => {
  try {
    const { payment_ref } = req.query;
    
    if (!payment_ref) {
      return res.status(400).json({ message: "Missing payment reference" });
    }

    // Get payment details from Konnect
    const paymentDetails = await axios.get(
      `${KONNECT_BASE_URL}/payments/${payment_ref}`,
      {
        headers: {
          "x-api-key": KONNECT_API_KEY,
          "Content-Type": "application/json"
        }
      }
    );

    const payment = paymentDetails.data.payment;
    
    // Find the purchase record by orderId (which we set to the purchase _id)
    const purchase = await CoursePurchase.findById(payment.orderId)
      .populate({ path: "courseId" });

    if (!purchase) {
      return res.status(404).json({ message: "Purchase not found" });
    }

    // Update purchase amount from Konnect response
    if (payment.amount) {
      purchase.amount = payment.amount / 1000; // Convert back from millimes
    }

    // Only process if payment is completed
    if (payment.status === "completed") {
      purchase.status = "completed";

      // Make all lectures visible by setting `isPreviewFree` to true
      if (purchase.courseId && purchase.courseId.lectures.length > 0) {
        await Lecture.updateMany(
          { _id: { $in: purchase.courseId.lectures } },
          { $set: { isPreviewFree: true } }
        );
      }

      await purchase.save();

      // Update user's enrolledCourses
      await User.findByIdAndUpdate(
        purchase.userId,
        { $addToSet: { enrolledCourses: purchase.courseId._id } },
        { new: true }
      );

      // Update course to add user ID to enrolledStudents
      await Course.findByIdAndUpdate(
        purchase.courseId._id,
        { $addToSet: { enrolledStudents: purchase.userId } },
        { new: true }
      );
    }

    return res.status(200).send();
  } catch (error) {
    console.error("Error handling Konnect webhook:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

// The following functions remain the same as they don't involve payment processing
export const getCourseDetailWithPurchaseStatus = async (req, res) => {
  try {
    const { courseId } = req.params;
    const userId = req.id;

    const course = await Course.findById(courseId)
      .populate({ path: "creator" })
      .populate({ path: "lectures" });

    const purchased = await CoursePurchase.findOne({ userId, courseId });

    if (!course) {
      return res.status(404).json({ message: "course not found!" });
    }

    return res.status(200).json({
      course,
      purchased: !!purchased,
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getAllPurchasedCourse = async (_, res) => {
  try {
    const purchasedCourse = await CoursePurchase.find({
      status: "completed",
    }).populate("courseId");
    
    return res.status(200).json({
      purchasedCourse: purchasedCourse || [],
    });
  } catch (error) {
    console.log(error);
    return res.status(500).json({ message: "Internal server error" });
  }
};
